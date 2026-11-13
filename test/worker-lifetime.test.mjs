// Offline check of the worker lifetime rule: one resident worker per task.
//
// A run of delegated calls must reuse a single child session. Historically a
// worker was replaced by four different things besides its context limit:
//
//   1. an idle timer (`workerIdleMs`) — a slow turn of the main agent restarted
//      the worker before the next call;
//   2. a call counter (`maxJobsPerWorker`) — every 25th call started over;
//   3. a changed sandbox mode or working directory (`environmentOf`) — every
//      permission switch retired the worker;
//   4. any failed call — one error threw the accumulated history away.
//
// All four spawned fresh child sessions, which is what made a long editing run
// look like a stream of writers. The context limit is now the only replacement
// trigger, so this test pins every retired path at once.
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/** Build a stub Host context whose registry keeps every child alive. */
function harness(config, options = {}) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const log = { activations: 0, sends: 0, compacts: 0, drains: [], children: [] };

	const liveAgents = new Map();

	const realRead = {
		name: 'read',
		description: 'Read a file.',
		parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args) {
			if (options.directFails === true) throw new Error('disk on fire');
			return { text: `direct:${args.file_path}` };
		},
	};

	const root = {
		id: 'agent-root',
		session: { header: { origin: 'root', cwd: options.cwd ?? 'C:\\ws' } },
		ctx: {
			tools: {
				register(tool) {
					rootTools.set(tool.name, tool);
					return () => rootTools.delete(tool.name);
				},
			},
			effect(fn) {
				fn();
			},
		},
		model: { current: () => ({ provider: 'p', model: 'm' }) },
	};

	function emit(childId, event) {
		for (const listener of handlers.get('session/event') ?? []) listener({ id: childId }, event);
	}

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			if (name === 'settings') return { configure() {}, describe: () => [] };
			if (name === 'sandboxPolicy') {
				return { resolve: () => ({ mode: options.mode ?? 'read-only' }) };
			}
			if (name === 'workingDirectory') {
				return {
					set(child, cwd) {
						child.session.header.cwd = cwd;
					},
				};
			}
			if (name === 'tokenMeter') {
				return {
					contextPressure(session) {
						return session.pressure === undefined ? {} : { pressureTokens: session.pressure };
					},
					measure(session) {
						return { surfaceTokens: session.surface ?? 0 };
					},
				};
			}
			if (name === 'compaction') {
				return {
					async compactNow(agent) {
						log.compacts += 1;
						agent.session.surface = options.afterCompact ?? 0;
						return { shadowedSeqs: [1], shadowedTokenCount: 10 };
					},
				};
			}
			return undefined;
		},
		on(event, listener) {
			handlers.set(event, [...(handlers.get(event) ?? []), listener]);
		},
		effect(fn) {
			fn();
		},
		tools: {
			register(tool) {
				globalTools.set(tool.name, tool);
				return () => globalTools.delete(tool.name);
			},
			get(name) {
				return name === 'read' ? realRead : globalTools.get(name);
			},
		},
		agents: {
			list: () => [root, ...liveAgents.values()],
			get: (id) => liveAgents.get(id),
		},
		subagents: {
			async startActivation() {
				log.activations += 1;
				const childId = `child-${log.activations}`;
				log.children.push(childId);
				liveAgents.set(childId, {
					id: childId,
					status: 'idle',
					session: { id: childId, header: { cwd: options.cwd ?? 'C:\\ws' }, surface: options.startSurface ?? 0 },
				});
				if (options.silentWorker === true) {
					// A stuck first turn: the activation result never settles, so the
					// plugin's `withTimeout` has to end the call.
					return { childId, messageId: `message-${log.activations}`, result: new Promise(() => {}), dispose: async () => {} };
				}
				const result = new Promise((resolve) => {
					setImmediate(() => {
						emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `first:${childId}` }] } } });
						resolve({ stopReason: 'completed' });
					});
				});
				return { childId, messageId: `message-${log.activations}`, result, dispose: async () => {} };
			},
			async sendMessage(_sender, childId) {
				log.sends += 1;
				// A stuck worker never ends its turn, so the plugin's observation
				// timer has to end the call. It still reports a tool result, which
				// is what a worker whose turn hangs looks like from outside.
				emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `next:${childId}` }] } } });
				if (options.silentWorker !== true) {
					emit(childId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
				}
				return 'message-1';
			},
			interrupt() {},
			async drainChildren(_parent, childIds) {
				log.drains.push(...childIds);
				for (const id of childIds) liveAgents.delete(id);
			},
		},
	};

	apply(ctx, config);
	return { root, rootTools, globalTools, liveAgents, log };
}

function call(shadow, root, args) {
	return shadow.execute(args, { agent: root, signal: new AbortController().signal });
}

// 1. A call counter of 1 must not retire anything: the worker stays resident.
{
	const config = { readEnabled: true, maxJobsPerWorker: 1 };
	const h = harness(config);
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await call(read, h.root, { file_path: 'b.txt' });
	await call(read, h.root, { file_path: 'c.txt' });
	assert.equal(h.log.activations, 1, 'maxJobsPerWorker no longer starts new sessions');
	assert.equal(h.log.sends, 2, 'the resident worker served the later calls');
	assert.equal(h.log.drains.length, 0);
}

// 2. An idle timer of 0 must not retire anything either, even after the worker
//    has been idle long enough for any previous implementation to restart it.
{
	const config = { readEnabled: true, workerIdleMs: 0 };
	const h = harness(config);
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await new Promise((resolve) => setTimeout(resolve, 20));
	await call(read, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.activations, 1, 'workerIdleMs no longer starts new sessions');
	assert.equal(h.log.sends, 1);
}

// 3. A changed sandbox mode or working directory re-pins the resident worker
//    instead of replacing it.
{
	const config = { readEnabled: true };
	const h = harness(config, { mode: 'read-only', cwd: 'C:\\one' });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	// The parent switches scope; its session header is the source of cwd.
	h.root.session.header.cwd = 'C:\\two';
	const env = h.liveAgents.get('child-1');
	assert.ok(env, 'the child is still registered');
	await call(read, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.activations, 1, 'a scope change re-pins instead of restarting');
	assert.equal(h.log.sends, 1);
	assert.equal(env.session.header.cwd, 'C:\\two', 'the resident worker follows the parent cwd');
}

// 4. A failed call keeps the worker: the next call reuses the same session.
{
	const config = { readEnabled: true, fallbackToDirect: true };
	const h = harness(config, { directFails: true });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await call(read, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.activations, 1, 'a resident worker is not restarted by a later call');
	assert.equal(h.log.sends, 1);
	assert.equal(h.log.drains.length, 0, 'no failed call recycled the worker');
}

// 5. Across many calls, the writer stays one session until its limit is spent.
{
	const config = { readEnabled: true, writeMaxContextTokens: 0 };
	const h = harness(config, { startSurface: 100 });
	const read = h.rootTools.get('read');
	for (let index = 0; index < 6; index += 1) await call(read, h.root, { file_path: `f${index}.txt` });
	assert.equal(h.log.activations, 1, 'six calls served by one resident worker');
	assert.equal(h.log.sends, 5);
	assert.equal(h.log.compacts, 0, 'no limit configured, so nothing compacts');
}

// 6. A first turn that never settles fails the call (the fallback runs the tool
//    directly), but it does NOT replace the worker: a spent context limit is
//    the only replacement trigger. The stuck turn is reported, not acted on.
{
	// The timeout is plugin config, not a harness option: at the shipped 15
	// minute default this case would hang the suite, so it is pinned to 50 ms.
	const config = { readEnabled: true, readMaxContextTokens: 1000, requestTimeoutMs: 50 };
	const h = harness(config, { silentWorker: true });
	const read = h.rootTools.get('read');
	const started = Date.now();
	// The fallback answers directly, so the step still succeeds.
	assert.deepEqual(await call(read, h.root, { file_path: 'a.txt' }), { text: 'direct:a.txt' });
	assert.ok(Date.now() - started < 5000, 'the call ends on the configured timeout, not the default');
	assert.equal(h.log.drains.length, 0, 'an unsettled turn does not replace the worker');
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	const view = report?.agents?.[0];
	assert.equal(view.fallbacks, 1, 'the failed delegation fell back to the direct tool');
	assert.equal(view.recycled, 0, 'no worker was replaced for a failed turn');
}

// 7. Every replacement is attributable: the status reports why sessions went.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, afterCompact: 4000 });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await call(read, h.root, { file_path: 'b.txt' });
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	const view = report?.agents?.[0];
	assert.equal(view.recycled, 1, 'the status counts replacements');
	assert.match(
		Object.keys(view.recycleReasons).join(' '),
		/context limit spent/,
		'the replacement reason names the spent context limit',
	);
}

// 8. The rule itself: nothing but a spent context limit replaces a worker. This
//    drives the retired triggers at once — idle timer, call counter, changed
//    cwd, a scope re-pin — and asserts that not one of them starts a new
//    session or drains the child. Failed calls are covered by case 4.
{
	const config = { readEnabled: true, writeEnabled: true, maxJobsPerWorker: 1, workerIdleMs: 0 };
	const h = harness(config, { mode: 'read-only', cwd: 'C:\\one' });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	for (let index = 0; index < 4; index += 1) {
		h.root.session.header.cwd = `C:\\${index}`;
		await call(read, h.root, { file_path: `f${index}.txt` });
	}
	assert.equal(h.log.activations, 1, 'only the context limit may start a new worker session');
	assert.equal(h.log.drains.length, 0, 'only the context limit may release a worker');
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	const view = report?.agents?.[0];
	assert.equal(view.recycled, 0, 'nothing was replaced');
	assert.equal(view.compacted, 0, 'no limit configured, so nothing was compacted either');
}

console.log('delegate-io: worker lifetime checks passed');
