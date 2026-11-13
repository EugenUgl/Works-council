// Offline check of the live per-task enable switch. Not part of the shipped
// bundle: `apply` runs against a stub Cordis context and a mutable config, so
// the test can flip `readEnabled` between calls exactly like the settings form
// does through the Host's volatile config reference.
//
// Regression: `mount` used to skip a task that started disabled and `execute`
// never read the flag, so the switch only had an effect on agents created
// after the change (typically a new chat).
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/** Build a stub Host context, a stub root agent, and one real `read` tool. */
function harness(config) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const drains = [];
	const log = { activations: 0, sends: 0, direct: 0, lastPrompt: '', children: [] };

	/** Live child agents by id: the registry the plugin looks a worker up in. */
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
			log.direct += 1;
			return { text: `direct:${args.file_path}` };
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
				return name === 'read' ? realRead : globalTools.get(name);
			},
		},
		agents: {
			// The plugin resolves a resident worker through the registry before
			// every call (see `liveWorkerAgent`); the stub keeps every announced
			// child registered so the resident path is exercised.
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
					setImmediate(() => {
						emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `delegated:${childId}` }] } } });
						resolve({ stopReason: 'completed' });
					});
				});
				return { childId, messageId: `message-${log.activations}`, result, dispose: async () => {} };
			},
			async sendMessage(_sender, childId, content) {
				log.sends += 1;
				log.lastPrompt = content[0].text;
				// The worker runs its turn and settles before this call returns.
				emit(childId, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: `continued:${childId}` }] } } });
				emit(childId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
				return 'message-1';
			},
			interrupt() {},
			async drainChildren(_parent, childIds) {
				drains.push(...childIds);
				for (const id of childIds) liveAgents.delete(id);
			},
		},
	};

	apply(ctx, config);
	return { root, rootTools, globalTools, drains, log };
}

/** Call one registered shadow tool as the root agent. */
function call(shadow, root, args) {
	return shadow.execute(args, { agent: root, signal: new AbortController().signal });
}

const config = { readEnabled: false };
const h = harness(config);

// 1. A task that starts switched off still gets its clone, so the switch can
//    be turned on later in the same session.
assert.ok(h.rootTools.has('read'), 'the read clone is registered even while disabled');
assert.ok(h.globalTools.has('delegate_io_status'), 'the status tool stays global');

const shadow = h.rootTools.get('read');
assert.match(shadow.description, /may be delegated/, 'the description does not promise delegation');

// 2. Disabled: the call runs the real tool in the main agent.
assert.deepEqual(await call(shadow, h.root, { file_path: 'a.txt' }), { text: 'direct:a.txt' });
assert.equal(h.log.direct, 1);
assert.equal(h.log.activations, 0, 'no worker is started while the task is off');

// 3. Switched on: the next call dispatches to a worker without a reload.
config.readEnabled = true;
assert.deepEqual(await call(shadow, h.root, { file_path: 'b.txt' }), { 'delegate-io': { text: 'delegated:child-1' } });
assert.equal(h.log.activations, 1);
assert.equal(h.log.direct, 1, 'the tool did not run directly');

// 4. The worker is resident now, so the following call reuses its session.
assert.deepEqual(await call(shadow, h.root, { file_path: 'c.txt' }), { 'delegate-io': { text: 'continued:child-1' } });
assert.equal(h.log.activations, 1, 'the session is reused');
assert.equal(h.log.sends, 1);

// 5. Switched off: the call runs directly and the resident worker is KEPT.
//    Switching delegation off is not a replacement trigger — only the worker's
//    own context limit is.
config.readEnabled = false;
assert.deepEqual(await call(shadow, h.root, { file_path: 'd.txt' }), { text: 'direct:d.txt' });
assert.deepEqual(h.drains, [], 'switching a task off does not release its worker');
assert.equal(h.log.activations, 1, 'no worker is started while the task is off');

// 6. Switched on again: the same resident session serves the call, with its
//    history intact.
config.readEnabled = true;
assert.deepEqual(await call(shadow, h.root, { file_path: 'e.txt' }), { 'delegate-io': { text: 'continued:child-1' } });
assert.equal(h.log.activations, 1, 'the kept worker resumes instead of a new session');

// 7. A call from another agent falls through to the real tool.
await shadow.execute({ file_path: 'f.txt' }, { agent: { id: 'agent-other' }, signal: new AbortController().signal });
assert.equal(h.log.direct, 3, 'foreign agents never reach the worker');

console.log('delegate-io: live enable checks passed');
