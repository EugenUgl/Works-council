// Offline checks for the report paths: `delegate_inspect` and the `summary`
// budget strategy. The stub worker scripts its events per call: a tool result,
// an assistant answer, or nothing at all.
import assert from 'node:assert/strict';
import { apply } from '../index.js';

/** Build a stub Host context with scripted worker turns. */
function harness(config) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const spills = [];
	const calls = { read: 0, workerPrompts: [], children: [] };
	const script = [];
	let childSeq = 0;
	/** Live child agents by id: the registry the plugin resolves workers in. */
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
			calls.read += 1;
			return { text: 'direct read' };
		},
	};

	/** Script the worker's next turn: the text it sends, or its failure. */
	const failWorker = (message) => script.push({ answer: `__fail__${message}` });

	/**
	 * Pick the scripted turn for one prompt. A digest pass is recognised by its
	 * own prompt text, so an asynchronous digest start never consumes the
	 * scripted entry meant for the file read.
	 */
	function turnFor(prompt) {
		const digest = /Write a technical digest of it/.test(prompt);
		if (digest) {
			const index = script.findIndex((entry) => entry.digest === true);
			if (index < 0) throw new Error('no scripted digest turn left');
			return script.splice(index, 1)[0];
		}
		const entry = script.shift();
		if (entry === undefined) throw new Error('no scripted worker turn left');
		return entry;
	}

	/** A scripted digest pass for the `summary` strategy. */
	const digestTurn = (answer) => script.push({ digest: true, toolResult: 'plugin.txt', answer });

	/** Emit one worker turn: each entry is applied in order and then turn/end. */	function runTurn(childId, prompt) {
		calls.workerPrompts.push(prompt);
		const entry = turnFor(prompt);
		const emit = (event) => {
			for (const listener of handlers.get('session/event') ?? []) listener({ id: childId }, event);
		};
		if (entry.toolResult !== undefined) {
			emit({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: entry.toolResult }] } } });
		}
		if (entry.answer !== undefined && entry.answer.startsWith('__fail__')) {
			// The worker turn ended without producing anything the caller can use.
			throw new Error(entry.answer.slice('__fail__'.length));
		}
		if (entry.answer !== undefined) {
			emit({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: entry.answer }] } } });
		}
		emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
	}

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
			if (name === 'spillStore') {
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
				return { ...realRead, name };
			},
		},
		agents: {
			// `liveWorkerAgent` asks the registry before every call; announce every
			// child here so the resident worker path stays reachable.
			list: () => [root, ...liveAgents.values()],
			get: (id) => liveAgents.get(id),
		},
		subagents: {
			async startActivation(request) {
				childSeq += 1;
				const childId = `child-${childSeq}`;
				calls.children.push(childId);
				liveAgents.set(childId, { id: childId, status: 'idle', session: { id: childId } });
				const result = new Promise((resolve) => {
					setImmediate(() => {
						try {
							runTurn(childId, request.request.prompt[0].text);
						} finally {
							resolve({ stopReason: 'completed' });
						}
					});
				});
				return { childId, messageId: 'm', result, dispose: async () => {} };
			},
			async sendMessage(_sender, childId, content) {
				runTurn(childId, content[0].text);
				return 'm';
			},
			interrupt() {},
			async drainChildren(_parent, childIds = []) {
				for (const id of childIds) liveAgents.delete(id);
			},
		},
	};

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
		webEnabled: false,
		writeEnabled: false,
		maxResultChars: 120,
		inspectEnabled: true,
		inspectMaxChars: 2000,
		depthBudget: 'normal',
		budgetStrategy: 'spill',
		...config,
	});

	return { root, rootTools, globalTools, spills, calls, script, digestTurn };
}

/** Run one global tool as the root agent. */
function call(h, name, args) {
	return h.globalTools.get(name).execute(args, { agent: h.root, signal: new AbortController().signal });
}

/** Run one delegated `read` through the shadow tool. */
async function read(h, args) {
	const shadow = h.rootTools.get('read');
	assert.ok(shadow !== undefined, 'the read clone is registered');
	const value = await shadow.execute(args, { agent: h.root, signal: new AbortController().signal });
	return value;
}

/** Live counters of the tracked root. */
async function status(h) {
	return (await call(h, 'delegate_io_status', {})).agents[0];
}

// --- delegate_inspect -------------------------------------------------------

// 1. The worker reads with its own tool and answers with a report: the report
//    reaches the caller and is prefixed with the inspected path.
{
	const h = harness({});
	h.script.push({
		toolResult: 'contents of plugin.txt',
		answer: 'found: the registry lives in index.js\nfragments:\nindex.js:40 mount()\nconfidence: high · not checked: tests',
	});
	const result = await call(h, 'delegate_inspect', { path: 'plugin.txt', focus: 'where is the registry' });
	assert.match(result.text, /^delegate-io inspect: plugin\.txt\n/);
	assert.match(result.text, /found: the registry lives in index\.js/);
	assert.match(h.calls.workerPrompts[0], /Inspect `plugin\.txt`/);
	assert.match(h.calls.workerPrompts[0], /never paraphrase code/);
	assert.equal((await status(h)).inspected, 1);
	assert.equal(h.calls.read, 0, 'the authoritative read did not run');
}

// 2. A worker that answered without calling any tool is refused.
{
	const h = harness({});
	h.script.push({ answer: 'found: everything looks fine\nconfidence: high' });
	await assert.rejects(call(h, 'delegate_inspect', { path: 'a.txt', focus: 'x' }), /answered without calling a tool/);
	const live = await status(h);
	assert.equal(live.inspected, 0);
}

// 3. A report longer than the inspect budget is spilled and cut.
{
	const h = harness({ inspectMaxChars: 200 });
	h.script.push({ toolResult: 'file', answer: 'found: '.padEnd(900, 'x') });
	const result = await call(h, 'delegate_inspect', { path: 'a.txt', focus: 'x' });
	assert.ok(result.text.length <= 400, 'the report is cut near the budget');
	assert.match(result.text, /characters elided/);
	assert.equal(h.spills.length, 1);
	assert.equal(h.spills[0].suggestedName, 'delegate_inspect-result.txt');
}

// 4. Switching the tool off refuses the call instead of running it.
{
	const h = harness({ inspectEnabled: false });
	await assert.rejects(call(h, 'delegate_inspect', { path: 'a.txt', focus: 'x' }), /delegate_inspect is switched off/);
}

// 5. A caller that is not the tracked main agent is refused.
{
	const h = harness({});
	await assert.rejects(
		h.globalTools.get('delegate_inspect').execute({ path: 'a.txt', focus: 'x' }, { agent: { id: 'child' }, signal: new AbortController().signal }),
		/available to the main agent only/,
	);
}

// 6. Depth selects the snippet budget in the prompt.
{
	const h = harness({ depthBudget: 'thorough' });
	h.script.push({ toolResult: 'file', answer: 'found: x' });
	await call(h, 'delegate_inspect', { path: 'a.txt', focus: 'x', depth: 'thorough' });
	assert.match(h.calls.workerPrompts[0], /at most 80 lines/);
}

// --- summary budget strategy ------------------------------------------------

// 7. With `summary`, an over-budget result becomes a marked digest of the full text.
{
	const h = harness({ budgetStrategy: 'summary', maxResultChars: 200 });
	h.script.push({ toolResult: 'A'.repeat(600) });
	h.digestTurn('digest: one function, no exports');
	const result = await read(h, { file_path: 'big.txt' });
	const text = result['delegate-io'].text;
	assert.match(text, /^\[delegate-io: digest of 600 characters; the full copy was saved/);
	assert.match(text, /digest: one function, no exports/);
	assert.equal(h.spills.length, 1, 'the full text is spilled');
	assert.equal(h.spills[0].content, 'A'.repeat(600));
	const live = await status(h);
	assert.equal(live.summarized, 1);
	assert.match(h.calls.workerPrompts[1], /Stay within 200 characters/);
}

// 8. The default strategy still cuts head and tail instead of digesting.
{
	const h = harness({ maxResultChars: 200 });
	h.script.push({ toolResult: 'A'.repeat(600) });
	const result = await read(h, { file_path: 'big.txt' });
	assert.match(result['delegate-io'].text, /characters elided/);
	assert.equal((await status(h)).summarized, 0);
	assert.equal(h.calls.workerPrompts.length, 1, 'no second pass ran');
}

// 9. A failed digest falls back to the head/tail cut and keeps the full spill.
{
	const h = harness({ budgetStrategy: 'summary', maxResultChars: 200 });
	h.script.push({ toolResult: 'A'.repeat(600) });
	h.script.push({ answer: '__fail__digest pass failed' });
	const result = await read(h, { file_path: 'big.txt' });
	assert.match(result['delegate-io'].text, /characters elided/);
	const live = await status(h);
	assert.equal(live.summarizeFallbacks, 1);
	assert.equal(live.summarized, 0);
}

// 10. A short result stays exact under the summary strategy.
{
	const h = harness({ budgetStrategy: 'summary', maxResultChars: 200 });
	h.script.push({ toolResult: 'short exact content' });
	const result = await read(h, { file_path: 'small.txt' });
	assert.equal(result['delegate-io'].text, 'short exact content');
	assert.equal(h.spills.length, 0);
}

// 11. The status tool reports the new settings.
{
	const h = harness({ budgetStrategy: 'summary', inspectMaxChars: 5000, depthBudget: 'overview' });
	const report = await call(h, 'delegate_io_status', {});
	assert.equal(report.budgetStrategy, 'summary');
	assert.equal(report.inspectMaxChars, 5000);
	assert.equal(report.depthBudget, 'overview');
	assert.equal(report.inspectEnabled, true);
}

console.log('delegate-io: inspect and summary checks passed');
