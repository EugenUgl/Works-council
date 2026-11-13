// Offline check of the per-worker context limit.
//
// A resident worker accumulates its own history across delegated calls. Once
// that history passes the task's `maxContextTokens`, the plugin compacts it
// through `ctx.compaction.compactNow` before handing over the next task, and
// recycles the worker when condensation cannot bring it back under the limit.
//
// The limit measures the model-visible surface, never provider usage: cache
// traffic is not context, and counting it made every cached worker look many
// times its real size and recycle on nearly every call.
//
// The stub context below models the runtime pieces the policy reads: the live
// child Agent with its Session (drives `ctx.tokenMeter`), the compaction seam,
// and the registry lookup used to resolve the child from its durable id.
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/** Build a stub Host context with meter, compaction, and an agent registry. */
function harness(config, options = {}) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const log = { activations: 0, sends: 0, compacts: 0, drains: [], children: [] };

	/** Live child agents by id, mirroring the runtime registry. */
	const liveAgents = new Map();

	const realRead = {
		name: 'read',
		description: 'Read a file.',
		parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute() {
			return { text: 'direct' };
		},
	};

	const root = {
		id: 'agent-root',
		session: { header: { origin: 'root', cwd: 'C:\\ws' } },
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

	/** Deliver one session event to the plugin's observer. */
	function emit(childId, event) {
		for (const listener of handlers.get('session/event') ?? []) listener({ id: childId }, event);
	}

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			if (name === 'settings') return { configure() {}, describe: () => [] };
			if (name === 'tokenMeter') {
				return {
					// Provider usage: includes cache traffic, so the limit must not
					// read it. It is present here to prove the plugin ignores it.
					contextPressure(session) {
						return session.pressure === undefined ? {} : { pressureTokens: session.pressure };
					},
					// The model-visible surface: what the context limit measures.
					measure(session) {
						return { surfaceTokens: session.surface ?? 0, totalTokens: session.pressure ?? 0 };
					},
				};
			}
			if (name === 'compaction' && options.withoutCompaction !== true) {
				return {
					async compactNow(agent) {
						log.compacts += 1;
						if (options.compactThrows === true) throw new Error('compaction refused');
						// Condensation lands the worker at the scripted residual.
						agent.session.surface = options.afterCompact ?? 0;
						agent.session.pressure = options.afterCompact ?? 0;
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
			list: () => (options.registryGetMissing === true ? [root] : [root, ...liveAgents.values()]),
			get: (id) => (options.registryGetMissing === true ? undefined : liveAgents.get(id)),
		},
		subagents: {
			async startActivation() {
				log.activations += 1;
				const childId = `child-${log.activations}`;
				log.children.push(childId);
				liveAgents.set(childId, {
					id: childId,
					status: 'idle',
					session: { id: childId, pressure: options.startPressure, surface: options.startSurface },
				});
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
				emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `next:${childId}` }] } } });
				emit(childId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
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

/** Call one registered shadow tool as the root agent. */
function call(shadow, root, args) {
	return shadow.execute(args, { agent: root, signal: new AbortController().signal });
}

// 1. No limit configured: a huge worker is left alone.
{
	const config = { readEnabled: true };
	const h = harness(config, { startSurface: 999999 });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	assert.equal(h.log.compacts, 0, 'a zero limit never compacts');
	assert.equal(h.log.activations, 1);
	assert.equal(h.log.drains.length, 0, 'a zero limit never recycles for context');
}

// 2. Under the limit: the worker keeps its session and no compaction runs.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 400 });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 0, 'a worker below its limit is not compacted');
	assert.equal(h.log.activations, 1, 'the resident session serves both calls');
	assert.equal(h.log.sends, 1);
}

// 3. Cache traffic is not context. This is the regression that spawned worker
//    sessions at a huge rate: provider usage (input + cache read + cache write)
//    was mistaken for the context size, so a small worker looked enormous.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 500, startPressure: 250000 });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 0, 'cache-read usage alone never triggers compaction');
	assert.equal(h.log.activations, 1, 'a cached worker keeps its session');
	assert.equal(h.log.drains.length, 0, 'a cached worker is never recycled for context');
}

// 4. Over the limit on the surface: the next call compacts first, then reuses
//    the session.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, afterCompact: 100 });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	const result = await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 1, 'an over-limit worker is compacted before the next task');
	assert.equal(h.log.activations, 1, 'compaction keeps the same worker session');
	assert.deepEqual(result, { 'delegate-io': { text: 'next:child-1' } }, 'the task still runs after compaction');
}

// 5. Compaction that cannot get under the limit: the worker is recycled.
//    A spent limit is the ONE replacement trigger.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, afterCompact: 4000 });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	const result = await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 1);
	assert.deepEqual(h.log.drains, ['child-1'], 'a worker still over its limit is recycled');
	assert.equal(h.log.activations, 2, 'the next call starts a fresh worker session');
	assert.deepEqual(result, { 'delegate-io': { text: 'first:child-2' } });
}

// 6. A failing compaction keeps the worker: restarting it would not make the
//    next task smaller, and a new child session costs the whole history.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, compactThrows: true });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	const result = await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 1);
	assert.equal(h.log.drains.length, 0, 'a failed compaction does not restart the worker');
	assert.equal(h.log.activations, 1, 'the resident session serves both calls');
	assert.deepEqual(result, { 'delegate-io': { text: 'next:child-1' } });
}

// 7. No compaction backend mounted: the worker is kept and the over-limit
//    condition is reported, not paid for with a new session.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, withoutCompaction: true });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.drains.length, 0, 'without a backend the worker is kept');
	assert.equal(h.log.activations, 1);
}

// 8. The child is gone from the registry: the record is kept as it is. A missing
//    child is not a policy reason to start a new session — only a spent context
//    limit replaces a worker.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 10, registryGetMissing: true });
	const shadow = h.rootTools.get('read');
	await call(shadow, h.root, { file_path: 'a.txt' });
	await call(shadow, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 0, 'an unreachable worker is not compacted');
	assert.equal(h.log.drains.length, 0, 'a missing child never triggers a replacement');
	assert.equal(h.log.activations, 1, 'no new session is started because the child went missing');
}

// 9. The limit is per worker: only a worker with its own limit is compacted.
{
	const config = { readEnabled: true, webEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, afterCompact: 10 });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await call(read, h.root, { file_path: 'b.txt' });
	assert.equal(h.log.compacts, 1, 'only the worker with a limit is compacted');
}

// 10. The status tool reports the limit, the measured context, and the live
//     compactions, so the policy is observable without reading logs.
{
	const config = { readEnabled: true, readMaxContextTokens: 1000 };
	const h = harness(config, { startSurface: 5000, afterCompact: 10 });
	const read = h.rootTools.get('read');
	await call(read, h.root, { file_path: 'a.txt' });
	await call(read, h.root, { file_path: 'b.txt' });
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	const view = report?.agents?.[0];
	assert.equal(view.compacted, 1, 'the status reports the compaction');
	assert.equal(view.compactionFailures, 0);
	const worker = view.workers.find((entry) => entry.task === 'read');
	assert.equal(worker.maxContextTokens, 1000, 'the status reports the configured limit');
	assert.equal(worker.contextTokens, 10, 'the status reports the context after compaction');
}

	console.log('delegate-io: worker context limit checks passed');

// 11. The status reports whether each global tool is actually reachable from the
//     calling agent. A model cannot read its own tool schema list, so without
//     this the claim "the tool is missing" is unverifiable from inside a
//     session — exactly the wrong claim made during a long debugging run where
//     the tool was present in every request header.
{
	const config = { readEnabled: true };
	const h = harness(config);
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	assert.ok(report.tools !== undefined, 'the status carries a tool-visibility section');
	assert.deepEqual(Object.keys(report.tools.tools).sort(), ['delegate_inspect', 'delegate_io_status', 'delegate_think']);
	for (const [name, entry] of Object.entries(report.tools.tools)) {
		assert.equal(typeof entry.registered, 'boolean', `${name} reports registration`);
		assert.equal(typeof entry.visible, 'boolean', `${name} reports visibility`);
	}
	// The stub registry answers every name, so every tool reads as reachable and
	// the summary must say so rather than inventing a problem.
	assert.match(report.tools.summary, /every global tool is registered and visible|not reachable/);
}

