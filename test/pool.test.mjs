// Offline check of the worker pool. Not part of the shipped bundle: `apply`
// runs against a stub Cordis context whose worker answers are held open, so the
// test can observe which calls overlap and which queue.
//
// Before the pool every call of one task serialised on a single promise chain,
// so three parallel reads waited for each other. The pool keeps the per-session
// history that makes calls cheap while letting up to `WORKERS_PER_TASK[task]`
// calls of one task run at once.
//
// Two regressions are pinned here:
// - `state.workers` is `task -> pool`; iterating it as `task -> worker` left the
//   settlement notices of slots 1 and 2 unfiltered (covered in prestep.test.mjs
//   too) and would have handed pool objects to `recycleChild`.
// - Choosing the worker at dispatch time is what makes the pool parallel; a fix
//   that creates three sessions but always queues on slot 0 changes nothing.
import assert from 'node:assert/strict';
import { apply, filterPreStep } from '../index.js';

/**
 * Build a stub Host context whose workers stay busy until the test releases them.
 *
 * `startActivation` and `sendMessage` resolve only when `release` is called for
 * their child id, which is what lets the test see how many calls are in flight
 * at the same time.
 */
function harness(config) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const liveAgents = new Map();
	const releases = new Map();
	const log = { activations: 0, sends: 0, children: [], startedAt: 0, continuedAt: [] };
	/** Children that finished their first turn, by id, in completion order. */
	const finished = [];

	const realRead = {
		name: 'read',
		description: 'Read a file.',
		parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args) {
			return { text: `direct:${args.file_path}` };
		},
	};

	const realWrite = {
		name: 'write',
		description: 'Write a file.',
		parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args) {
			return { text: `written:${args.file_path}` };
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

	/**
	 * Wait until a child has an outstanding `release`, then fire it.
	 *
	 * @param {string} childId The worker session to answer.
	 * @param {string} text The tool result text it produces.
	 * @param {{ failed?: boolean }} [options] `failed` marks the result as an
	 * error, which is what the observer reads as `observation.failed`.
	 */
	async function release(childId, text, options = {}) {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const release = releases.get(childId);
			if (release !== undefined) {
				releases.delete(childId);
				release(text, options.failed === true);
				return;
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
		throw new Error(`the test never saw child ${childId} waiting`);
	}

	/** Resolve on a later macrotask so every pending promise chain settles. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			return name === 'settings' ? { configure() {}, describe: () => [] } : undefined;
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
				// The plugin asks for the tool it is about to shadow, always from
				// the root agent's scope; answering with the clone would shadow it.
				if (name === 'read') return realRead;
				if (name === 'write' || name === 'edit') return realWrite;
				return globalTools.get(name);
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
				liveAgents.set(childId, { id: childId, status: 'idle', session: { id: childId } });
				const result = new Promise((resolve) => {
					releases.set(childId, (text, failed = false) => {
						finished.push(childId);
						emit(childId, {
							type: 'tool/result',
							data: { message: { content: [{ type: 'text', text }] }, ...(failed ? { error: { message: text || 'read failed' } } : {}) },
						});
						resolve({ stopReason: 'completed' });
					});
				});
				return { childId, messageId: `message-${log.activations}`, result, dispose: async () => {} };
			},
			async sendMessage(_sender, childId) {
				log.sends += 1;
				log.continuedAt.push(childId);
				// Held open exactly like a first turn, so queued calls stay visible.
				return new Promise((resolve) => {
					releases.set(childId, (text) => {
						emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } });
						emit(childId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
						resolve('message-1');
					});
				});
			},
			interrupt() {},
			async drainChildren(_parent, childIds) {
				for (const id of childIds) liveAgents.delete(id);
			},
		},
	};

	apply(ctx, config);
	return { root, rootTools, globalTools, releases, release, settle, log, finished, emit };
}

/** Call one registered shadow tool as the root agent. */
function call(shadow, root, args) {
	return shadow.execute(args, { agent: root, signal: new AbortController().signal });
}

// 1. Lazy at both layers: nothing exists until the first call, and that first
//    call takes ONE session, not the whole pool.
{
	const h = harness({ readEnabled: true });
	const read = h.rootTools.get('read');
	assert.equal(h.log.activations, 0, 'mounting the clone starts no worker');

	const first = call(read, h.root, { file_path: 'a.txt' });
	await h.settle();
	assert.equal(h.log.activations, 1, 'a serial first call wakes slot 0 only');

	await h.release('child-1', 'delegated:a');
	assert.deepEqual(await first, { 'delegate-io': { text: 'delegated:a' } });
	assert.equal(h.log.activations, 1, 'the pool members are records, not sessions');
}

// 2. Three parallel reads run on three sessions at once: all three are started
//    before any of them answers.
{
	const h = harness({ readEnabled: true });
	const read = h.rootTools.get('read');
	const pending = ['a', 'b', 'c'].map((name) => call(read, h.root, { file_path: `${name}.txt` }));
	await h.settle();
	assert.equal(h.log.activations, 3, 'three parallel reads start three sessions');
	assert.deepEqual(h.finished, [], 'none of them finished yet');
	await h.release('child-1', 'delegated:1');
	await h.release('child-2', 'delegated:2');
	await h.release('child-3', 'delegated:3');
	const results = await Promise.all(pending);
	assert.deepEqual(results, [
		{ 'delegate-io': { text: 'delegated:1' } },
		{ 'delegate-io': { text: 'delegated:2' } },
		{ 'delegate-io': { text: 'delegated:3' } },
	]);
}

// 3. A serial task keeps using slot 0: eight calls in a row wake one session
//    and continue it seven times. This is the history D8 pays for.
{
	const h = harness({ readEnabled: true });
	const read = h.rootTools.get('read');
	const first = call(read, h.root, { file_path: 'a.txt' });
	await h.settle();
	await h.release('child-1', 'delegated:a');
	await first;
	for (let index = 0; index < 7; index += 1) {
		const next = call(read, h.root, { file_path: `n${index}.txt` });
		await h.settle();
		await h.release('child-1', `continued:${index}`);
		await next;
	}
	assert.equal(h.log.activations, 1, 'a serial task never wakes slots 1 and 2');
	assert.equal(h.log.sends, 7);
	assert.deepEqual([...new Set(h.log.continuedAt)], ['child-1'], 'every continuation stays on slot 0');
}

// 4. Beyond the pool the calls queue instead of piling onto one session: the
//    fourth read waits for a free slot and then runs on that same session.
{
	const h = harness({ readEnabled: true });
	const read = h.rootTools.get('read');
	const pending = ['a', 'b', 'c', 'd'].map((name) => call(read, h.root, { file_path: `${name}.txt` }));
	await h.settle();
	assert.equal(h.log.activations, 3, 'a full pool starts three sessions, the fourth waits');
	assert.equal(h.log.sends, 0, 'the queued call has not reached a worker yet');
	await h.release('child-1', 'delegated:1');
	await h.settle();
	assert.equal(h.log.sends, 1, 'the queued call ran on the freed slot');
	assert.equal(h.log.activations, 3, 'no fourth session was started');
	assert.deepEqual(h.log.continuedAt, ['child-1'], 'it continued the freed session');
	await h.release('child-1', 'continued:1');
	await h.release('child-2', 'delegated:2');
	await h.release('child-3', 'delegated:3');
	const results = await Promise.all(pending);
	assert.deepEqual(results.map((result) => result['delegate-io'].text), ['delegated:1', 'delegated:2', 'delegated:3', 'continued:1']);
}

// 5. Different tasks stay independent: a write does not wait for a busy read.
{
	const h = harness({ readEnabled: true, writeEnabled: true });
	const read = h.rootTools.get('read');
	const write = h.rootTools.get('write');
	const readCall = call(read, h.root, { file_path: 'a.txt' });
	await h.settle();
	const writeCall = call(write, h.root, { file_path: 'b.txt' });
	await h.settle();
	assert.equal(h.log.activations, 2, 'the write starts its own session while the read is busy');
	await h.release('child-2', 'written');
	await writeCall;
	assert.equal(h.finished.includes('child-2'), true, 'the write settled before the read');
	await h.release('child-1', 'delegated');
	await readCall;
}

// 6. A pool slot is replaced only by its own context limit: one failed slot does
//    not touch the other two, and the failed call does not recycle anything.
{
	const h = harness({ readEnabled: true, fallbackToDirect: true });
	const read = h.rootTools.get('read');
	const pending = ['a', 'b', 'c'].map((name) => call(read, h.root, { file_path: `${name}.txt` }));
	await h.settle();
	assert.equal(h.log.activations, 3);
	// Slot 0 answers with an error tool result. A failed tool result is not a
	// failed call: it reaches the main agent as ordinary content and the
	// session is kept, exactly like the single-worker case.
	await h.release('child-1', 'read failed', { failed: true });
	const [firstResult] = await Promise.all([pending[0]]);
	assert.deepEqual(firstResult, { 'delegate-io': { text: 'read failed' } });
	await h.release('child-2', 'delegated:2');
	await h.release('child-3', 'delegated:3');
	await pending[1];
	await pending[2];
	assert.equal(h.log.activations, 3, 'a failed slot is not recycled');
	assert.equal(h.log.sends, 0, 'the neighbours were not reused for the failed call');
}

// 7. The status report lists every pool slot with its index, so "which worker"
//    is answerable without reading logs.
{
	const h = harness({ readEnabled: true });
	const read = h.rootTools.get('read');
	const first = call(read, h.root, { file_path: 'a.txt' });
	await h.settle();
	await h.release('child-1', 'delegated');
	await first;
	const status = h.globalTools.get('delegate_io_status');
	const report = await status.execute({}, { agent: h.root, signal: new AbortController().signal });
	const view = report?.agents?.[0];
	assert.equal(view.workers.length, 3, 'the report shows the whole read pool');
	assert.deepEqual(view.workers.map((worker) => worker.task), ['read', 'read', 'read']);
	assert.deepEqual(view.workers.map((worker) => worker.slot), [0, 1, 2]);
	assert.deepEqual(view.workers.map((worker) => worker.childId), ['child-1', null, null], 'only the used slot has a session');
}

// 8. Two mutations of ONE file are serialised on one slot even though the
//    write pool has three members. Each job takes its `before` snapshot inside
//    the job, so a parallel pair of edits would both predict from the same
//    content and the second verification would "repair" the file from that
//    stale prediction, silently dropping the first edit. Serialising on one
//    chain is what prevents it; a hash collision is acceptable, a lost edit is
//    not.
{
	const h = harness({ writeEnabled: true, verifyWrites: false });
	const write = h.rootTools.get('write');
	const first = call(write, h.root, { file_path: 'same.txt', content: 'one' });
	await h.settle();
	assert.equal(h.log.activations, 1, 'the first mutation starts one writer');
	const second = call(write, h.root, { file_path: 'same.txt', content: 'two' });
	await h.settle();
	assert.equal(h.log.sends, 0, 'the second mutation waits: still one turn in the slot');
	assert.equal(h.log.activations, 1, 'and it does not open a second writer');
	await h.release('child-1', 'written:one');
	await first;
	await h.settle();
	assert.equal(h.log.sends, 1, 'the second mutation ran on the same slot afterwards');
	assert.deepEqual(h.log.continuedAt, ['child-1'], 'same file, same chain');
	await h.release('child-1', 'written:two');
	await second;

	// Two DIFFERENT files do run at the same time; the pool is not serial.
	const third = call(write, h.root, { file_path: 'other.txt', content: 'three' });
	const fourth = call(write, h.root, { file_path: 'third.txt', content: 'four' });
	await h.settle();
	const inFlight = h.log.activations + h.log.sends;
	assert.ok(inFlight >= 2, 'different files go to different slots');
	await h.release('child-2', 'ok');
	await h.release('child-3', 'ok');
	await Promise.all([third, fourth]);
}

// 9. The settlement-notice filter resolves every pool slot, not just slot 0.
//    Iterating `state.workers` as `task -> worker` left slots 1 and 2 noisy:
//    their notices reached the model's next step.
{
	const notice = {
		id: 'notice',
		role: 'user',
		content: [{ type: 'text', text: 'Background subagent child-2 finished and will do no more work.' }],
	};
	const poolState = {
		workers: new Map([
			[
				'read',
				{
					task: 'read',
					workers: [
						{ task: 'read', slot: 0, childId: 'child-1' },
						{ task: 'read', slot: 1, childId: 'child-2' },
						{ task: 'read', slot: 2, childId: undefined },
					],
				},
			],
		]),
	};
	assert.deepEqual(filterPreStep(poolState, { kind: 'enter', messages: [notice] }).messages, [], 'a slot-1 notice is filtered');
	// An unrelated child is still left alone.
	const foreign = { ...notice, id: 'foreign', content: [{ type: 'text', text: 'Background subagent child-foreign finished.' }] };
	assert.equal(filterPreStep(poolState, { kind: 'enter', messages: [foreign] }).messages.length, 1);
}

console.log('delegate-io: worker pool checks passed');
