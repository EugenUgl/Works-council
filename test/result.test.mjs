// Offline checks for the two result guarantees: a delegated result is spilled
// and capped, and a delegated write/edit is verified against the file on disk.
// `apply` runs against a stub Cordis context with an in-memory filesystem.
import assert from 'node:assert/strict';
import { apply, budgetText, expectedContentOf, sameFileText } from '../index.js';

/** In-memory file system plus the two authoritative tools. */
function harness(config, options = {}) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const files = new Map(Object.entries(options.files ?? {}));
	const spills = [];
	const calls = { write: 0, edit: 0, read: 0 };
	const behaviors = [];

	const real = {
		read: {
			name: 'read',
			description: 'Read a file.',
			parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
			output: {
				schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
				render: (_args, value) => [{ type: 'text', text: value.text }],
			},
			async execute(args) {
				calls.read += 1;
				return { text: files.get(args.file_path) ?? '' };
			},
		},
		write: {
			name: 'write',
			description: 'Write a file.',
			parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
			output: {
				schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
				render: (_args, value) => [{ type: 'text', text: value.text }],
			},
			async execute(args) {
				calls.write += 1;
				files.set(args.file_path, args.content);
				return { text: `wrote ${args.content.length} characters` };
			},
		},
		edit: {
			name: 'edit',
			description: 'Edit a file.',
			parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
			output: {
				schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
				render: (_args, value) => [{ type: 'text', text: value.text }],
			},
			async execute(args) {
				calls.edit += 1;
				const before = files.get(args.file_path) ?? '';
				files.set(args.file_path, expectedContentOf('edit', args, before) ?? before);
				return { text: `edited ${args.file_path}` };
			},
		},
	};
	if (options.withoutWrite === true) delete real.write;

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			if (name === 'fs' && options.withoutFs !== true) {
				return {
					async resolve(path) {
						return { targetKey: path, displayPath: path };
					},
					async stat(target) {
						if (!files.has(target.targetKey)) return undefined;
						const text = files.get(target.targetKey);
						return { type: 'file', size: text.length, version: '1' };
					},
					async readText(target) {
						if (!files.has(target.targetKey)) throw new Error('absent');
						return files.get(target.targetKey);
					},
				};
			}
			if (name === 'spillStore' && options.withoutSpill !== true) {
				return {
					async saveText(input) {
						spills.push(input);
						return { locator: `spill-${spills.length}`, bytes: input.content.length, retrievalHint: 'Read the saved copy with the read tool.' };
					},
				};
			}
			if (name === 'settings') return { configure() {}, describe: () => [] };
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
				return real[name];
			},
		},
		agents: { list: () => [root] },
		subagents: {
			async startActivation(request) {
				const childId = `child-${behaviors.length + 1}`;
				const result = new Promise((resolve) => {
					setImmediate(() => {
						runBehavior(childId, request.request.prompt[0].text);
						resolve({ stopReason: 'completed' });
					});
				});
				return { childId, messageId: 'm', result, dispose: async () => {} };
			},
			async sendMessage(_sender, childId, content) {
				runBehavior(childId, content[0].text);
				return 'm';
			},
			interrupt() {},
			async drainChildren() {},
		},
	};

	/** Apply the next scripted worker effect and settle its turn. */
	function runBehavior(childId, prompt) {
		const behavior = behaviors.shift();
		if (behavior === undefined) throw new Error('no scripted worker behavior left');
		behavior.apply?.(files, prompt);
		const message = { content: [{ type: 'text', text: behavior.text(behavior) }] };
		if (behavior.failed === true) message.isError = true;
		for (const listener of handlers.get('session/event') ?? []) {
			listener(
				{ id: childId },
				{ type: 'tool/result', data: { message, ...(behavior.failed === true ? { error: { code: 'x', name: 'ToolError' } } : {}) } },
			);
			listener({ id: childId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
		}
	}

	const root = {
		id: 'agent-root',
		session: { id: 'session-1', header: { origin: 'root', cwd: 'C:\\ws' } },
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

	apply(ctx, {
		readEnabled: true,
		writeEnabled: true,
		webEnabled: false,
		maxResultChars: 100000,
		verifyWrites: true,
		...config,
	});

	return { root, rootTools, globalTools, files, spills, calls, behaviors };
}

/** Run one shadow tool call as the root agent. */
async function call(h, tool, args) {
	const shadow = h.rootTools.get(tool);
	assert.ok(shadow !== undefined, `${tool} is registered`);
	return shadow.execute(args, { agent: h.root, signal: new AbortController().signal });
}

/** Live counters from the status tool. */
async function status(h) {
	const value = await h.globalTools.get('delegate_io_status').execute();
	return value.agents[0];
}

// --- pure helpers -----------------------------------------------------------

assert.equal(expectedContentOf('write', { content: 'x' }), 'x');
assert.equal(expectedContentOf('edit', { old_string: 'a', new_string: 'b' }, 'a-a'), 'b-a');
assert.equal(expectedContentOf('edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'a-a'), 'b-b');
assert.equal(expectedContentOf('edit', { old_string: 'z', new_string: 'b' }, 'a-a'), undefined);
assert.equal(expectedContentOf('read', {}, 'a'), undefined);
assert.equal(sameFileText('a\r\nb', 'a\nb'), true);
assert.equal(sameFileText('a', 'b'), false);
assert.match(budgetText('x'.repeat(100), 40, { bytes: 100, retrievalHint: 'hint' }), /characters elided/);

// --- result budget ----------------------------------------------------------

{
	const h = harness({ readEnabled: true, maxResultChars: 40 });
	h.behaviors.push({ text: () => 'A'.repeat(400) });
	const result = await call(h, 'read', { file_path: 'big.txt' });
	const text = result['delegate-io'].text;
	assert.ok(text.length < 400, 'the delegated result is capped');
	assert.match(text, /of 400 characters elided/);
	assert.match(text, /Read the saved copy/);
	assert.equal(h.spills.length, 1);
	assert.equal(h.spills[0].content.length, 400, 'the spilled copy keeps the full text');
	assert.equal(h.spills[0].owner.sessionId, 'session-1');
	assert.equal((await status(h)).truncated, 1);
}

// An unlimited budget leaves the result whole and spills nothing.
{
	const h = harness({ readEnabled: true, maxResultChars: 0 });
	h.behaviors.push({ text: () => 'A'.repeat(400) });
	const result = await call(h, 'read', { file_path: 'big.txt' });
	assert.equal(result['delegate-io'].text.length, 400);
	assert.equal(h.spills.length, 0);
}

// Without a spill store the full text is preferable to losing it.
{
	const h = harness({ readEnabled: true }, { withoutSpill: true });
	h.behaviors.push({ text: () => 'A'.repeat(400) });
	const result = await call(h, 'read', { file_path: 'big.txt' });
	assert.equal(result['delegate-io'].text.length, 400);
}

// --- write verification -----------------------------------------------------

// The worker writes exactly what it was asked to: no repair, no extra write.
{
	const h = harness({ writeEnabled: true });
	h.behaviors.push({
		apply: (files) => files.set('out.txt', 'exact content'),
		text: () => 'wrote out.txt',
	});
	await call(h, 'write', { file_path: 'out.txt', content: 'exact content' });
	assert.equal(h.files.get('out.txt'), 'exact content');
	assert.equal(h.calls.write, 0, 'the authoritative tool did not run');
	const live = await status(h);
	assert.equal(live.verified, 1);
	assert.equal(live.repaired, 0);
}

// The worker mangles the content: the file is rewritten with what was asked for.
{
	const h = harness({ writeEnabled: true });
	h.behaviors.push({
		apply: (files) => files.set('out.txt', 'mangled'),
		text: () => 'wrote out.txt',
	});
	const result = await call(h, 'write', { file_path: 'out.txt', content: 'exact content' });
	assert.equal(h.files.get('out.txt'), 'exact content');
	assert.equal(h.calls.write, 1, 'the authoritative tool repaired the file');
	assert.match(result['delegate-io'].text, /did not match the requested content/);
	assert.equal((await status(h)).repaired, 1);
}

// The worker reports success but leaves no file: the file is created from the
// requested content.
{
	const h = harness({ writeEnabled: true });
	h.behaviors.push({ apply: () => {}, text: () => 'wrote out.txt' });
	const result = await call(h, 'write', { file_path: 'out.txt', content: 'exact content' });
	assert.equal(h.files.get('out.txt'), 'exact content');
	assert.equal(h.calls.write, 1);
	assert.match(result['delegate-io'].text, /no file on disk/);
}

// A worker whose tool call failed is left alone: its error text reaches the caller.
{
	const h = harness({ writeEnabled: true });
	h.behaviors.push({ apply: () => {}, text: () => 'permission denied', failed: true });
	const result = await call(h, 'write', { file_path: 'out.txt', content: 'exact content' });
	assert.equal(result['delegate-io'].text, 'permission denied');
	assert.equal(h.calls.write, 0, 'the failure is not second-guessed');
	assert.equal((await status(h)).unverified, 0);
}

// --- edit verification ------------------------------------------------------

// A correct delegated edit is verified from the snapshot taken before it.
{
	const h = harness({ writeEnabled: true }, { files: { 'a.txt': 'hello world' } });
	h.behaviors.push({
		apply: (files) => files.set('a.txt', 'hello there'),
		text: () => 'edited a.txt',
	});
	const result = await call(h, 'edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' });
	assert.equal(result['delegate-io'].text, 'edited a.txt');
	assert.equal(h.files.get('a.txt'), 'hello there');
	assert.equal((await status(h)).verified, 1);
}

// A divergent delegated edit is repaired with the predicted content.
{
	const h = harness({ writeEnabled: true }, { files: { 'a.txt': 'hello world' } });
	h.behaviors.push({
		apply: (files) => files.set('a.txt', 'goodbye every world'),
		text: () => 'edited a.txt',
	});
	const result = await call(h, 'edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' });
	assert.equal(h.files.get('a.txt'), 'hello there', 'the file holds the predicted edit');
	assert.match(result['delegate-io'].text, /rewritten with the expected content/);
	assert.equal((await status(h)).repaired, 1);
}

// Without the write tool a divergent edit fails loudly instead of silently
// succeeding, and the edit is not applied a second time.
{
	const h = harness({ writeEnabled: true }, { files: { 'a.txt': 'hello world' }, withoutWrite: true });
	h.behaviors.push({
		apply: (files) => files.set('a.txt', 'corrupted'),
		text: () => 'edited a.txt',
	});
	await assert.rejects(call(h, 'edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' }), /did not produce the requested content/);
	assert.equal(h.calls.edit, 0, 'the authoritative edit did not run again');
}

// Verification can be switched off.
{
	const h = harness({ writeEnabled: true, verifyWrites: false });
	h.behaviors.push({ apply: (files) => files.set('out.txt', 'mangled'), text: () => 'wrote out.txt' });
	await call(h, 'write', { file_path: 'out.txt', content: 'exact content' });
	assert.equal(h.files.get('out.txt'), 'mangled');
	assert.equal(h.calls.write, 0);
}

console.log('delegate-io: result budget and write verification checks passed');
