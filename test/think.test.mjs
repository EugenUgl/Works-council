// Offline checks for the thinking worker: `delegate_think` and the escalate
// hint. The stub worker scripts its answer per call; it never calls tools,
// because the thinker has none and asks its caller instead.
import assert from 'node:assert/strict';
import { apply, parseThinkReply } from '../index.js';

/** Build a stub Host context with scripted worker answers. */
function harness(config) {
	const handlers = new Map();
	const globalTools = new Map();
	const rootTools = new Map();
	const calls = { workerPrompts: [], children: [], activations: 0, sends: 0 };
	const script = [];
	const activations = [];
	let childSeq = 0;

	const realRead = {
		name: 'read',
		description: 'Read a file.',
		parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args) {
			if (config.failRead === true) throw new Error(`cannot read ${args.file_path}: denied`);
			return { text: `direct:${args.file_path}` };
		},
	};

	/** Emit one worker answer and settle its turn. */
	function runTurn(childId, prompt) {
		calls.workerPrompts.push(prompt);
		const entry = script.shift();
		if (entry === undefined) throw new Error('no scripted worker turn left');
		const emit = (event) => {
			for (const listener of handlers.get('session/event') ?? []) listener({ id: childId }, event);
		};
		if (entry.toolResult !== undefined) {
			emit({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: entry.toolResult }] } } });
		}
		if (entry.answer !== undefined) {
			emit({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: entry.answer }] } } });
		}
		emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
	}

	const ctx = {
		logger: { info() {}, warn() {} },
		get(name) {
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
				return name === 'read' ? realRead : undefined;
			},
		},
		agents: { list: () => [root] },
		subagents: {
			async startActivation(request) {
				calls.activations += 1;
				childSeq += 1;
				const childId = `child-${childSeq}`;
				calls.children.push(childId);
				activations.push(request);
				if (config.escalateDelegation === true) {
					return {
						childId,
						messageId: 'm',
						result: Promise.reject(new Error('worker unavailable')),
						dispose: async () => {},
					};
				}
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
				calls.sends += 1;
				runTurn(childId, content[0].text);
				return 'm';
			},
			interrupt() {},
			async drainChildren() {},
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
		model: { current: () => ({ provider: 'main', model: 'main-model', reasoningEffort: 'off' }) },
	};

	apply(ctx, {
		readEnabled: true,
		webEnabled: false,
		writeEnabled: false,
		thinkEnabled: true,
		thinkProvider: '',
		thinkModel: '',
		thinkReasoningEffort: 'high',
		thinkMaxTurns: 2,
		thinkEscalateAfter: 2,
		fallbackToDirect: true,
		...config,
	});

	return { root, rootTools, globalTools, calls, script, activations };
}

/** Run one global tool as the root agent. */
function call(h, name, args) {
	return h.globalTools.get(name).execute(args, { agent: h.root, signal: new AbortController().signal });
}

/** Live counters of the tracked root. */
async function status(h) {
	return (await call(h, 'delegate_io_status', {})).agents[0];
}

const decision = (diagnosis, nextStep) => JSON.stringify({ diagnosis, nextStep, evidence: ['the exact error'], risks: ['none'], confidence: 'high' });

// --- pure parser ------------------------------------------------------------

assert.deepEqual(parseThinkReply('{"diagnosis":"fix it","nextStep":"retry"}'), { diagnosis: 'fix it', nextStep: 'retry' });
assert.deepEqual(parseThinkReply('```json\n{"need":"the whole stack trace"}\n```'), { need: 'the whole stack trace' });
assert.equal(parseThinkReply('{"need":"a","diagnosis":"b"}'), undefined, 'a reply cannot ask and decide at once');
assert.equal(parseThinkReply('{"diagnosis":""}'), undefined, 'an empty diagnosis is not a decision');
assert.equal(parseThinkReply('I think you should retry'), undefined, 'prose is not a decision');
assert.equal(parseThinkReply(undefined), undefined);

// --- the tool ---------------------------------------------------------------

// 1. A decision reaches the caller as text, without any tool call from the worker.
{
	const h = harness({});
	h.script.push({ answer: decision('the retry loop never resets', 'reset the counter after a success') });
	const result = await call(h, 'delegate_think', { question: 'why does it loop?', evidence: 'exit 1 twice' });
	assert.match(result.text, /^delegate-io think: why does it loop\?\n/);
	assert.match(result.text, /diagnosis: the retry loop never resets/);
	assert.match(result.text, /next step: reset the counter after a success/);
	assert.equal(h.calls.activations, 1, 'the worker ran in its own spawned session');
	const live = await status(h);
	assert.equal(live.thought, 1);
	assert.equal(live.thinkFailed, 0);
}

// 2. The thinker carries its own effort, not the main agent's `off` route.
{
	const h = harness({ thinkProvider: 'thinker-provider', thinkModel: 'thinker-model' });
	h.script.push({ answer: decision('decided', 'act') });
	await call(h, 'delegate_think', { question: 'q', evidence: 'e' });
	const options = h.activations[0].request.agentOptions;
	assert.equal(options.provider, 'thinker-provider');
	assert.equal(options.model, 'thinker-model');
	assert.equal(options.reasoningEffort, 'high', 'the thinker reasons even though the main agent does not');
}

// 3. An empty route inherits the main agent's provider and model but keeps `high`.
{
	const h = harness({});
	h.script.push({ answer: decision('decided', 'act') });
	await call(h, 'delegate_think', { question: 'q', evidence: 'e' });
	const options = h.activations[0].request.agentOptions;
	assert.equal(options.provider, 'main');
	assert.equal(options.model, 'main-model');
	assert.equal(options.reasoningEffort, 'high', 'inheriting the route must not inherit `off`');
}

// 4. A question comes back as the result and never as a silent retry.
{
	const h = harness({});
	h.script.push({ answer: '{"need":"the full stack trace"}' });
	const result = await call(h, 'delegate_think', { question: 'q', evidence: 'e' });
	assert.match(result.text, /the thinker needs one fact before deciding: the full stack trace/);
	assert.match(result.text, /call delegate_think again/);
	assert.equal(h.calls.sends, 0, 'the caller is never messaged mid-call');
	assert.equal((await status(h)).thinkAsks, 1);
}

// 5. A reply with no usable object fails loudly instead of passing prose on.
{
	const h = harness({});
	h.script.push({ answer: 'I would try restarting the service.' });
	await assert.rejects(call(h, 'delegate_think', { question: 'q', evidence: 'e' }), /without a valid decision object/);
	assert.equal((await status(h)).thinkFailed, 1);
}

// 6. The switch and the caller check both refuse.
{
	const h = harness({ thinkEnabled: false });
	await assert.rejects(call(h, 'delegate_think', { question: 'q', evidence: 'e' }), /thinking worker is switched off/);
}
{
	const h = harness({});
	await assert.rejects(
		h.globalTools.get('delegate_think').execute({ question: 'q', evidence: 'e' }, { agent: { id: 'child' }, signal: new AbortController().signal }),
		/available to the main agent only/,
	);
}

// 7. The rounds budget is stated in the prompt the worker receives.
{
	const h = harness({ thinkMaxTurns: 1 });
	h.script.push({ answer: decision('decided', 'act') });
	await call(h, 'delegate_think', { question: 'q', evidence: 'e' });
	assert.match(h.calls.workerPrompts[0], /You may ask at most 1 time/);
}
{
	const h = harness({ thinkMaxTurns: 0 });
	h.script.push({ answer: decision('decided', 'act') });
	await call(h, 'delegate_think', { question: 'q', evidence: 'e' });
	assert.match(h.calls.workerPrompts[0], /You may not ask anything/);
}

// --- escalate gate ----------------------------------------------------------

// 8. The hint rides a settled result, and only once the tool has failed enough
//    times in a row. The stub therefore fails the delegation but not the direct
//    call: the direct call is what the caller receives.
{
	const h = harness({ escalateDelegation: true, thinkEnabled: true, thinkEscalateAfter: 2 });
	const shadow = h.rootTools.get('read');
	const exec = { agent: h.root, signal: new AbortController().signal };
	const first = await shadow.execute({ file_path: 'a.txt' }, exec);
	assert.equal(first.text, 'direct:a.txt', 'the first failure carries no hint and keeps the tool shape');
	const second = await shadow.execute({ file_path: 'a.txt' }, exec);
	assert.match(second['delegate-io'].text, /"read" has failed 2 times in a row/);
	assert.match(second['delegate-io'].text, /this is the point for delegate_think/);
}

// 8a. Regression: with the thinker switched off the hint must say so instead of
//     recommending a tool the model does not have. The shipped profile has
//     `thinkEnabled: false`, and the old wording ("delegate_think is available")
//     was false in exactly that configuration — the model was told about a tool
//     it could not call, which is how a long investigation went by without ever
//     asking the thinker.
{
	const h = harness({ escalateDelegation: true, thinkEnabled: false, thinkEscalateAfter: 2 });
	const shadow = h.rootTools.get('read');
	const exec = { agent: h.root, signal: new AbortController().signal };
	await shadow.execute({ file_path: 'a.txt' }, exec);
	const second = await shadow.execute({ file_path: 'a.txt' }, exec);
	const text = second['delegate-io'].text;
	assert.match(text, /"read" has failed 2 times in a row/);
	assert.match(text, /delegate_think would decide this, but the thinking worker is switched off/);
	assert.doesNotMatch(text, /is available/, 'a disabled thinker is never advertised as available');
}

// 8b. The attempt budget: when failures keep happening while the per-tool
//     counter stays low, the hint must fire anyway — the case the thinker
//     exists for (several different hypotheses, each failing differently).
{
	const h = harness({ escalateDelegation: true, thinkEnabled: true, thinkEscalateAfter: 5 });
	const shadow = h.rootTools.get('read');
	const exec = { agent: h.root, signal: new AbortController().signal };
	let hinted = '';
	for (let index = 0; index < 4; index += 1) {
		// One failure at a time, then a success resets the per-tool count while the
		// overall attempt count keeps its record across the run.
		const result = await shadow.execute({ file_path: `f${index}.txt` }, exec);
		if (String(result?.['delegate-io']?.text ?? '').includes('different errors')) hinted = result['delegate-io'].text;
	}
	assert.match(hinted, /delegated calls have failed with different errors/);
	assert.match(hinted, /this is the point for delegate_think/);
}

// 9. A success resets the count, so the hint is not a permanent nag.
{
	const h = harness({ thinkEscalateAfter: 2 });
	const shadow = h.rootTools.get('read');
	const exec = { agent: h.root, signal: new AbortController().signal };
	h.script.push({ toolResult: 'a real answer' });
	const ok = await shadow.execute({ file_path: 'a.txt' }, exec);
	assert.equal(ok['delegate-io'].text, 'a real answer', 'a delegated success is returned whole');
}

// 10. A zero threshold switches the hint off entirely, on both triggers.
{
	const h = harness({ escalateDelegation: true, thinkEnabled: true, thinkEscalateAfter: 0 });
	const shadow = h.rootTools.get('read');
	const exec = { agent: h.root, signal: new AbortController().signal };
	for (let index = 0; index < 5; index += 1) {
		const result = await shadow.execute({ file_path: 'a.txt' }, exec);
		assert.ok(!String(result?.['delegate-io']?.text ?? '').includes('delegate_think'), 'a zero threshold never hints');
	}
}

console.log('delegate-io: thinking worker checks passed');
