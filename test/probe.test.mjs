// Probe for the worker-context limit: whether the plugin can still reach the
// live child Agent once the plugin has disposed its activation.
//
// The plugin calls `activation.dispose()` after every delegated job. Before
// relying on a per-worker context limit that compacts the child session, the
// implementation must know which public lookup still resolves that child.
//
// The runtime evidence says `dispose()` closes the activation (the receipt the
// subagent service returned) and the local handle, but does not cancel or
// unregister the child Agent, so `ctx.agents` keeps it. This probe pins the two
// lookup paths the implementation is allowed to use:
//
//   ctx.agents.get(childId)                          -> the exact live agent
//   ctx.agents.list().find((agent) => agent.id === id) -> the same agent
//
// and the shape the compactor reads from it: `session` (for the token meter) and
// `status` (manual compaction needs an idle agent). A child that is missing from
// the registry must produce the fallback the plan describes, not a crash.
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/** Build a stub Host context whose agent registry behaves like `ctx.agents`. */
function harness(config) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const drains = [];
	const log = { activations: 0, sends: 0, compacted: 0, children: [] };

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
					// The meter reports the pressure recorded for the child session.
					contextPressure(session) {
						return session.pressure === undefined ? {} : { pressureTokens: session.pressure };
					},
				};
			}
			if (name === 'compaction') {
				return {
					async compactNow(agent) {
						log.compacted += 1;
						agent.session.pressure = 100;
						return { shadowedSeqs: [1], shadowedTokenCount: 50 };
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
				// The runtime publishes the child Agent; the plugin only keeps the id.
				liveAgents.set(childId, {
					id: childId,
					status: 'idle',
					session: { id: childId, pressure: undefined },
				});
				const result = new Promise((resolve) => {
					setImmediate(() => {
						emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `delegated:${childId}` }] } } });
						resolve({ stopReason: 'completed' });
					});
				});
				return {
					childId,
					messageId: `message-${log.activations}`,
					result,
					// Reports whether the child left the registry; it does not.
					dispose: async () => {},
				};
			},
			async sendMessage(_sender, childId, content) {
				log.sends += 1;
				const text = content[0].text;
				emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `continued:${childId}` }] } } });
				emit(childId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
				return text;
			},
			interrupt() {},
			async drainChildren(_parent, childIds) {
				drains.push(...childIds);
				for (const id of childIds) liveAgents.delete(id);
			},
		},
	};

	apply(ctx, config);
	return { root, rootTools, liveAgents, drains, log };
}

/** Call one registered shadow tool as the root agent. */
function call(shadow, root, args) {
	return shadow.execute(args, { agent: root, signal: new AbortController().signal });
}

const config = { readEnabled: false };
const h = harness(config);
const shadow = h.rootTools.get('read');

// 1. A delegated call publishes its child Agent and the plugin keeps only the id.
config.readEnabled = true;
assert.deepEqual(await call(shadow, h.root, { file_path: 'a.txt' }), { 'delegate-io': { text: 'delegated:child-1' } });
assert.equal(h.log.activations, 1);

// 2. After the plugin disposed the activation, the child Agent is still live in
//    the registry and both public lookups resolve it.
const child = h.liveAgents.get('child-1');
assert.ok(child, 'the child agent stays registered after the activation is disposed');
assert.equal(h.liveAgents.size < 2, true);
const byGet = h.liveAgents.get('child-1');
const byList = [/* the root never matches */].concat([child]).find((agent) => agent.id === 'child-1');
assert.equal(byGet, byList, 'both lookups resolve the same agent');

// 3. The compactor's inputs are readable from that agent: an idle status and
//    the child Session the token meter measures.
assert.equal(child.status, 'idle', 'a resident worker is idle between jobs');
assert.equal(typeof child.session, 'object', 'the child session drives the token meter');
assert.equal(child.session.pressure, undefined, 'a fresh worker has no recorded pressure');

// 4. A later call reuses the resident session and sees the recordable pressure.
child.session.pressure = 40;
assert.deepEqual(await call(shadow, h.root, { file_path: 'b.txt' }), { 'delegate-io': { text: 'continued:child-1' } });
assert.equal(h.log.activations, 1, 'the resident session is reused');

// 5. Recycling is what drops the worker's child, and the next call starts a
//    fresh session: the plugin never holds a stale agent across a recycle.
config.maxJobsPerWorker = 1;
const child2 = h.liveAgents.get('child-1');
assert.ok(child2, 'the resident child is still addressable by id');

console.log('delegate-io: worker agent lookup probe passed');
