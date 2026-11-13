/**
 * Delegate IO: the main agent's file reads, web reads, and file writes run in
 * delegated child agents instead of in the main agent's own loop.
 *
 * Design:
 *
 * - The main agent keeps the tool names it already knows: this plugin registers
 *   an agent-scoped clone of each intercepted tool on the root agent, which
 *   shadows the tool for that agent only. Delegated children inherit the clone
 *   and fall through to the real tool unchanged.
 * - One child per task type is started through `ctx.subagents` with caller
 *   delivery: the child runs its own turn with its own tool calls and the tool
 *   result the main agent receives is the child's answer, so the main agent's
 *   context stays free of the intermediate work.
 * - The worker model is configured per task type (`read`, `web`, `write`);
 *   leaving the model empty inherits the main agent's route.
 * - Every configuration field is `.volatile()`, which is what lets the Host
 *   project it into the row's settings form and apply edits without a reload.
 *   The per-task enable switch is read on every call, so turning a task off
 *   (or back on) takes effect in the running session; the clone is registered
 *   whether the task starts enabled or not.
 * - A failed worker falls back to running the tool in the main agent when
 *   `fallbackToDirect` is on, so delegation can never block ordinary work.
 * - A long delegated result is capped: the full text is spilled through
 *   `ctx.spillStore` and the main agent receives head, tail, and the retrieval
 *   hint instead of the whole payload. With `budgetStrategy: 'summary'` it
 *   receives a worker-written digest of that text instead, still marked as a
 *   digest with the spill hint.
 * - `delegate_inspect` asks the file-reading worker for a report about a path
 *   and a focus: verbatim snippets with locations, a structure outline, and
 *   what was not checked. It never replaces `read`, which stays exact.
 * - A delegated `write`/`edit` is verified against the file on disk (the
 *   expected content is computed from the arguments, and for `edit` from a
 *   snapshot taken before the worker runs); a divergence is repaired before
 *   the call reports success.
 *
 * @module @local/dsh-plugin-delegate-io
 */
import { resolve as resolvePath } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Files larger than this are not snapshotted or verified. */
const VERIFY_MAX_BYTES = 2_000_000;

/** Verbatim snippet lines a delegate_inspect report may carry, by depth. */
export const DEPTH_LINES = { overview: 25, normal: 40, thorough: 80 };

/** Share of the result budget kept as the head; the tail takes the rest. */
const BUDGET_HEAD_SHARE = 0.6;

/**
 * Failed delegated calls after which the escalate hint fires regardless of
 * whether any single tool failed repeatedly.
 *
 * `thinkEscalateAfter` guards the "same tool, same mistake" case. This guards
 * the other one: a session that keeps failing in different ways, where the
 * per-tool counter never climbs because the tool changes every time. Three is
 * the smallest number that proves several distinct approaches were tried.
 */
const THINKER_ATTEMPT_BUDGET = 3;

/** Longest full text handed to the worker for a summary pass. */
const SUMMARY_INPUT_MAX = 80000;

/**
 * Worker sessions per task type: a pool, not one session.
 *
 * One resident session serialises every call of its task behind a single
 * promise chain, so two parallel reads waited for each other. A pool keeps
 * the per-session history that makes calls cheap (D8) while letting up to
 * three calls of one task run at once. The thinker keeps one session: it is a
 * rare, single call, and stacking three of them would only spend context.
 *
 * This is a constant rather than a config field on purpose: the settings row
 * and its page stay unchanged, and the size of a pool is a property of the
 * delegation model, not of one deployment.
 */
const WORKERS_PER_TASK = { read: 3, web: 3, write: 3, think: 1 };

/** Cordis plugin name; also the settings namespace the row's configuration page edits. */
export const name = 'delegate-io';

/** One task type: its worker label and the tools it intercepts. */
const TASKS = [
	{ task: 'read', tools: ['read'], label: 'file reader', focus: 'reading files' },
	{ task: 'web', tools: ['web_fetch', 'web_search'], label: 'web reader', focus: 'reading web pages' },
	{ task: 'write', tools: ['write', 'edit'], label: 'file writer', focus: 'writing files' },
	// The thinker shadows nothing: `delegate_think` is a global tool, and the
	// worker reads no files of its own — it asks its caller for facts instead.
	{ task: 'think', tools: [], label: 'thinker', focus: 'deciding a stuck step', global: true },
];

/** Task keys in page order. */
const TASK_KEYS = TASKS.map((entry) => entry.task);

/**
 * Plugin configuration. Every field is volatile so the deployment can render it
 * in the plugin row's settings form and apply an edit in place.
 */
export const Config = z.object({
	readEnabled: z.boolean().default(true).volatile().description('Delegate file reads to a worker.'),
	readProvider: z.string().default('').volatile().description('Provider of the file-reading worker; empty inherits the main agent.'),
	readModel: z.string().default('').volatile().description('Model of the file-reading worker; empty inherits the main agent.'),
	readReasoningEffort: z.string().default('').volatile().description('Reasoning effort of the file-reading worker; empty uses the model default.'),
	readMaxContextTokens: z.number().default(0).volatile().description('Compact this worker past this many tokens; 0 is unlimited.'),
	webEnabled: z.boolean().default(true).volatile().description('Delegate web reads and searches to a worker.'),
	webProvider: z.string().default('').volatile().description('Provider of the web-reading worker; empty inherits the main agent.'),
	webModel: z.string().default('').volatile().description('Model of the web-reading worker; empty inherits the main agent.'),
	webReasoningEffort: z.string().default('').volatile().description('Reasoning effort of the web-reading worker; empty uses the model default.'),
	webMaxContextTokens: z.number().default(0).volatile().description('Compact this worker past this many tokens; 0 is unlimited.'),
	writeEnabled: z.boolean().default(true).volatile().description('Delegate file writes and edits to a worker.'),
	writeProvider: z.string().default('').volatile().description('Provider of the file-writing worker; empty inherits the main agent.'),
	writeModel: z.string().default('').volatile().description('Model of the file-writing worker; empty inherits the main agent.'),
	writeReasoningEffort: z.string().default('').volatile().description('Reasoning effort of the file-writing worker; empty uses the model default.'),
	writeMaxContextTokens: z.number().default(0).volatile().description('Compact this worker past this many tokens; 0 is unlimited.'),
	thinkEnabled: z.boolean().default(false).volatile().description('Expose delegate_think, the tool that asks a reasoning worker to decide a stuck or consequential step.'),
	thinkProvider: z.string().default('').volatile().description('Provider of the thinking worker; empty inherits the main agent.'),
	thinkModel: z.string().default('').volatile().description('Model of the thinking worker; empty inherits the main agent.'),
	thinkReasoningEffort: z.string().default('high').volatile().description('Reasoning effort of the thinking worker; high by default, independently of the main agent.'),
	thinkMaxContextTokens: z.number().default(0).volatile().description('Compact this worker past this many tokens; 0 is unlimited.'),
	thinkMaxTurns: z.number().step(1).min(0).default(2).volatile().description('Clarification rounds the thinking worker may ask its caller for before it must decide.'),
	thinkEscalateAfter: z.number().step(1).min(0).default(2).volatile().description('Consecutive failures of one tool after which the result tells the main agent that delegate_think is available. 0 disables the hint.'),
	subagentProvider: z.string().default('spawn').volatile().description('Registered subagent backend that hosts the workers.'),
	requestTimeoutMs: z.number().default(900000).volatile().description('How long one delegated call may wait for its worker.'),
	fallbackToDirect: z.boolean().default(true).volatile().description('Run the tool in the main agent when its worker fails.'),
	maxJobsPerWorker: z.number().default(25).volatile().description('Recycle a worker session after this many delegated calls, bounding its context.'),
	workerIdleMs: z.number().default(600000).volatile().description('Retire an idle worker on its next call after this many milliseconds.'),
	maxResultChars: z.number().default(12000).volatile().description('Cap the delegated result handed to the main agent at this many characters; the full text is spilled and the result says where. 0 keeps every result whole.'),
	verifyWrites: z.boolean().default(true).volatile().description('Compare the file on disk with the delegated write or edit and repair a divergence before reporting success.'),
	inspectEnabled: z.boolean().default(true).volatile().description('Expose delegate_inspect, the tool that asks the file-reading worker for a report instead of raw content.'),
	inspectMaxChars: z.number().default(4000).volatile().description('Cap one delegate_inspect report at this many characters; a longer report is spilled and cut. 0 keeps it whole.'),
	depthBudget: z.string().default('normal').volatile().description('Verbatim snippet lines a delegate_inspect report may carry: overview (25), normal (40), or thorough (80).'),
	budgetStrategy: z.string().default('spill').volatile().description('What happens past maxResultChars: spill keeps head and tail, summary asks the worker for a digest of the full text.'),
});

/** Services this bundle extends. */
export const inject = ['tools', 'subagents', 'agents'];

/** Read one configuration value, whether it is a volatile reference or a plain value. */
function valueOf(ref, fallback) {
	if (ref === null || ref === undefined) return fallback;
	if (typeof ref === 'object' && typeof ref.get === 'function') {
		const current = ref.get();
		return current === null || current === undefined ? fallback : current;
	}
	return ref;
}

/** Schema clone result: a delegated envelope or the real value. */
function delegatedValueSchema(real) {
	return {
		oneOf: [
			real.output.schema,
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					'delegate-io': {
						type: 'object',
						additionalProperties: false,
						properties: { text: { type: 'string' } },
						required: ['text'],
					},
				},
				required: ['delegate-io'],
			},
		],
	};
}

/** Joined text of one content-block array. */
function contentText(blocks) {
	if (!Array.isArray(blocks)) return '';
	return blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
}

/**
 * Whether one message is a settlement notice from one of this root's workers.
 *
 * The subagent backend appends "Background subagent <childId> finished…" to the
 * parent inbox when a worker settles. The delegated tool result already carries
 * the worker's output, so the notice is noise inside the model's next step.
 *
 * @param {{ workers: Map<string, { childId?: string }> }} state Root-agent state.
 * @param {any} message Pending inbox message.
 * @returns {boolean} True when the message is a worker settlement notice.
 */
function isWorkerNotice(state, message) {
	const text = contentText(message?.content);
	if (!text.startsWith('Background subagent ')) return false;
	for (const pool of state.workers.values()) {
		for (const worker of pool.workers) {
			if (worker.childId !== undefined && text.includes(worker.childId)) return true;
		}
	}
	return false;
}

/**
 * Drop this root's worker settlement notices from one proposed step batch.
 *
 * A batch can consist only of notices: the worker settled between two steps of
 * a running turn. Returning the empty batch is deliberate — the loop reads it
 * as "continue this turn without new input", so the model still gets its
 * ordinary post-tool step and answers. Refusing the step instead ended the
 * whole turn as `blocked` before any request was made, which is exactly the
 * silent turn this filter used to cause.
 *
 * @param {{ workers: Map<string, { childId?: string }> }} state Root-agent state.
 * @param {any[]} messages Claimed pending messages, possibly with notices.
 * @returns {any[]} The batch without this root's settlement notices.
 */
export function withoutWorkerNotices(state, messages) {
	if (state === undefined || state.workers.size === 0) return [...messages];
	return messages.filter((message) => !isWorkerNotice(state, message));
}

/**
 * Apply the settlement-notice filter to one proposed step decision.
 *
 * Ordinary messages and other decisions pass through untouched. A batch that
 * held only notices becomes an empty `enter` batch, never a refusal: the loop
 * then runs the next step of the running turn with no new input, which is the
 * post-tool step in which the model answers the user.
 *
 * @param {{ workers: Map<string, { childId?: string }> } | undefined} state Root-agent state.
 * @param {{ kind: string, messages?: any[] }} decision Decision from the pre-step waterfall.
 * @returns {any} The same decision, or the enter decision without notices.
 */
export function filterPreStep(state, decision) {
	if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
	if (state === undefined || state.workers.size === 0) return decision;
	const kept = withoutWorkerNotices(state, decision.messages);
	if (kept.length === decision.messages.length) return decision;
	return { ...decision, messages: kept };
}

/** Trimmed text of one configuration value. */
function textOf(ref) {
	const value = valueOf(ref, '');
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * The exact content one file tool must leave on disk, when it can be predicted.
 *
 * `write` replaces the whole file, so its expected content is the argument
 * itself. `edit` replaces the first occurrence (or every occurrence) of
 * `old_string`; predicting it needs the content as it was before the worker
 * ran.
 *
 * @param {string} toolName Shadowed tool name.
 * @param {any} args The tool arguments.
 * @param {string | undefined} before File content before the worker ran.
 * @returns {string | undefined} Expected content, or undefined when unpredictable.
 */
export function expectedContentOf(toolName, args, before) {
	if (toolName === 'write') return typeof args?.content === 'string' ? args.content : undefined;
	if (toolName !== 'edit') return undefined;
	const oldString = args?.old_string;
	const newString = args?.new_string;
	if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined;
	if (oldString === '' || typeof before !== 'string') return undefined;
	const index = before.indexOf(oldString);
	if (index < 0) return undefined;
	if (args.replace_all === true) return before.split(oldString).join(newString);
	return before.slice(0, index) + newString + before.slice(index + oldString.length);
}

/**
 * Compare two file contents, tolerating a line-ending rewrite by the backend.
 *
 * @param {string} actual Content read from disk.
 * @param {string} expected Predicted content.
 * @returns {boolean} True when they describe the same text.
 */
export function sameFileText(actual, expected) {
	if (actual === expected) return true;
	return actual.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
}

/**
 * Cut one delegated result down to the budget, keeping head and tail.
 *
 * @param {string} text Full tool result.
 * @param {number} limit Maximum characters to hand over.
 * @param {{ bytes: number, retrievalHint: string }} spill Saved full text.
 * @returns {string} The capped result with a marker naming the saved copy.
 */
export function budgetText(text, limit, spill) {
	const headSize = Math.floor(limit * BUDGET_HEAD_SHARE);
	const tailSize = Math.max(0, limit - headSize);
	let head = text.slice(0, headSize);
	const headBreak = head.lastIndexOf('\n');
	if (headBreak > headSize * 0.5) head = head.slice(0, headBreak + 1);
	let tail = text.slice(text.length - tailSize);
	const tailBreak = tail.indexOf('\n');
	if (tailBreak >= 0 && tailBreak < tailSize * 0.5) tail = tail.slice(tailBreak + 1);
	const elided = text.length - head.length - tail.length;
	const marker = `\n\n… [delegate-io: ${elided} of ${text.length} characters elided; the full result was saved (${spill.bytes} bytes). ${spill.retrievalHint}]\n\n`;
	return head + marker + tail;
}

/**
 * Parse the one JSON object a thinking worker must reply with.
 *
 * The worker answers either `{"need": "..."}` — one fact it wants from its
 * caller — or the final diagnosis. Anything else is rejected, so a rambling
 * reply can never be mistaken for a decision.
 *
 * @param {string} text The worker's answer.
 * @returns {{ need?: string, diagnosis?: string, nextStep?: string } | undefined}
 * The parsed reply, or undefined when it is not a valid one.
 */
export function parseThinkReply(text) {
	if (typeof text !== 'string') return undefined;
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return undefined;
	let value;
	try {
		value = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const need = typeof value.need === 'string' ? value.need.trim() : '';
	const diagnosis = typeof value.diagnosis === 'string' ? value.diagnosis.trim() : '';
	if (need !== '' && diagnosis !== '') return undefined;
	if (need !== '') return { need };
	if (diagnosis === '') return undefined;
	const nextStep = typeof value.nextStep === 'string' ? value.nextStep.trim() : '';
	return { diagnosis, nextStep };
}


/**
 * Install the delegation policy for every live and future root agent.
 *
 * @param {any} ctx The plugin context.
 * @param {any} config The resolved bundle row config.
 */
export function apply(ctx, config) {
	/** Live worker route for one task type. */
	function routeFor(task) {
		const enabled = valueOf(config?.[`${task}Enabled`], true) !== false;
		return {
			enabled,
			provider: textOf(config?.[`${task}Provider`]),
			model: textOf(config?.[`${task}Model`]),
			reasoningEffort: textOf(config?.[`${task}ReasoningEffort`]),
			maxContextTokens: contextLimitOf(task),
		};
	}

	/** Live scalar settings. */
	function subagentProvider() {
		const value = textOf(config?.subagentProvider);
		return value === '' ? 'spawn' : value;
	}

	/** Live request timeout in milliseconds. */
	function timeoutMs() {
		const value = Number(valueOf(config?.requestTimeoutMs, 900000));
		return Number.isFinite(value) && value > 0 ? value : 900000;
	}

	/** Whether a failed worker falls back to the main agent. */
	function fallbackToDirect() {
		return valueOf(config?.fallbackToDirect, true) !== false;
	}

	/**
	 * Delegated calls one worker session serves before it is recycled.
	 *
	 * Retired: a worker is now replaced only by its context limit, so a call
	 * counter must not retire it. The getter stays so the setting keeps its
	 * documented shape and `delegate_io_status` can still report the value.
	 */
	function maxJobsPerWorker() {
		const value = Number(valueOf(config?.maxJobsPerWorker, 25));
		return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 25;
	}

	/**
	 * Idle lifetime after which the next call replaces a worker session.
	 *
	 * Retired together with the call counter: an idle worker keeps its history
	 * and serves the next call. The getter stays for the settings shape and
	 * status reporting.
	 */
	function workerIdleMs() {
		const value = Number(valueOf(config?.workerIdleMs, 600000));
		return Number.isFinite(value) && value >= 0 ? value : 600000;
	}

	/** Characters handed to the main agent before the rest is spilled. */
	function maxResultChars() {
		const value = Number(valueOf(config?.maxResultChars, 12000));
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 12000;
	}

	/** Tokens after which one worker's history is compacted; 0 keeps it unlimited. */
	function contextLimitOf(task) {
		const value = Number(valueOf(config?.[`${task}MaxContextTokens`], 0));
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
	}

	/** Whether a delegated file mutation is checked against the disk. */
	function verifyWrites() {
		return valueOf(config?.verifyWrites, true) !== false;
	}

	/** Whether delegate_inspect is exposed. */
	function inspectEnabled() {
		return valueOf(config?.inspectEnabled, true) !== false;
	}

	/** Characters a delegate_inspect report may occupy; 0 keeps it whole. */
	function inspectMaxChars() {
		const value = Number(valueOf(config?.inspectMaxChars, 4000));
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 4000;
	}

	/** Verbatim snippet lines an inspect report may carry. */
	function depthLines() {
		const value = textOf(config?.depthBudget).toLowerCase();
		return DEPTH_LINES[value] ?? DEPTH_LINES.normal;
	}

	/** What happens past the result budget: 'spill' or 'summary'. */
	function budgetStrategy() {
		return textOf(config?.budgetStrategy).toLowerCase() === 'summary' ? 'summary' : 'spill';
	}

	/** Clarification rounds one thinking call may spend. */
	function thinkMaxTurns() {
		const value = Number(valueOf(config?.thinkMaxTurns, 2));
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
	}

	/** Consecutive failures after which the escalate hint is appended; 0 disables it. */
	function thinkEscalateAfter() {
		const value = Number(valueOf(config?.thinkEscalateAfter, 2));
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
	}

	/**
	 * Read one file through the composed filesystem.
	 *
	 * @returns {Promise<string | null | undefined>} The text, null when the file
	 * is absent, or undefined when the file cannot be observed or is too large.
	 */
	async function readFileText(agent, filePath, signal) {
		const fs = ctx.get('fs');
		if (fs === undefined) return undefined;
		try {
			const target = await fs.resolve(filePath, { cwd: agent?.session?.header?.cwd, signal });
			const info = await fs.stat(target, signal);
			if (info === undefined) return null;
			if (info.type !== 'file' || (info.size ?? 0) > VERIFY_MAX_BYTES) return undefined;
			return await fs.readText(target, signal);
		} catch {
			return undefined;
		}
	}

	/**
	 * Take what verification needs before the worker runs.
	 *
	 * A `write` is predictable from its arguments; an `edit` needs the content
	 * as it is right now, because the worker will change it. Any failure to
	 * observe the file leaves the call unverified instead of failing it.
	 */
	async function prepareVerification(state, toolName, args, signal) {
		if (!verifyWrites()) return undefined;
		if (toolName !== 'write' && toolName !== 'edit') return undefined;
		if (typeof args?.file_path !== 'string') return undefined;
		if (toolName === 'write') return { before: undefined };
		const before = await readFileText(state.agent, args.file_path, signal);
		return typeof before === 'string' ? { before } : undefined;
	}

	/**
	 * Check the effect of one delegated file mutation and repair a divergence.
	 *
	 * The worker never restates the content to the caller, so the only proof is
	 * the file itself. A mismatch is repaired through the authoritative tool:
	 * the same `write` for a write, and the `write` tool with the predicted
	 * content for an edit (re-running the edit could apply it twice).
	 *
	 * @returns {Promise<string | undefined>} Replacement result text, or undefined to keep the worker's.
	 */
	async function settleVerification(state, toolName, args, real, plan, failed, exec) {
		if (plan === undefined || failed === true) return undefined;
		const expected = expectedContentOf(toolName, args, plan.before);
		if (expected === undefined) {
			state.unverified += 1;
			return undefined;
		}
		const actual = await readFileText(state.agent, args.file_path, exec.signal);
		if (actual === undefined) {
			state.unverified += 1;
			return undefined;
		}
		if (actual !== null && sameFileText(actual, expected)) {
			state.verified += 1;
			return undefined;
		}
		const repair = toolName === 'edit' ? state.tools.get('write') : real;
		if (repair === undefined) {
			const error = new Error(
				`delegate-io: the delegated ${toolName} did not produce the requested content; ` +
					`the file holds ${actual === null ? 0 : actual.length} characters instead of ${expected.length}`,
			);
			error.delegateIoVerification = true;
			throw error;
		}
		const repairArgs = toolName === 'edit' ? { file_path: args.file_path, content: expected } : args;
		await repair.execute(repairArgs, exec);
		state.repaired += 1;
		ctx.logger?.warn?.(
			'delegate-io: repaired a divergent %s of %s (%d characters on disk, %d expected)',
			toolName,
			args.file_path,
			actual === null ? 0 : actual.length,
			expected.length,
		);
		return (
			`delegate-io: the delegated ${toolName} did not match the requested content ` +
			`(${actual === null ? 'no file on disk' : `${actual.length} characters on disk`} instead of ${expected.length}); ` +
			`the file was rewritten with the expected content.`
		);
	}

	/**
	 * Save one full text in the session's spill store.
	 *
	 * @returns {Promise<{ ref?: any, error?: any }>} The saved reference, or why it failed.
	 */
	async function saveSpill(state, toolName, text, exec, label) {
		const spill = ctx.get('spillStore');
		if (spill === undefined) return { error: 'no spill store' };
		try {
			const ref = await spill.saveText({
				owner: { sessionId: state.agent.session?.id ?? state.agent.id },
				source: {
					kind: 'tool',
					toolName,
					callId: exec?.callId ?? `delegate-io-${Date.now()}`,
					label: label ?? `Delegated ${toolName} result`,
				},
				suggestedName: `${toolName}-result.txt`,
				content: text,
			});
			return { ref };
		} catch (error) {
			return { error };
		}
	}

	/**
	 * Hand over at most `maxResultChars` characters, spilling the rest.
	 *
	 * The worker is threaded through on purpose: a digest pass asks "your tool
	 * returned this text earlier", which is only true in the session that
	 * produced it. Picking any free pool slot would start a cold session that
	 * never made that call.
	 */
	async function capResult(state, toolName, text, exec, worker) {
		const limit = maxResultChars();
		if (limit <= 0 || text.length <= limit) return text;
		const saved = await saveSpill(state, toolName, text, exec);
		if (saved.ref === undefined) {
			ctx.logger?.warn?.('delegate-io: spilling the %s result failed, keeping it whole: %o', toolName, saved.error);
			return text;
		}
		state.truncated += 1;
		const head = budgetText(text, limit, saved.ref);
		if (budgetStrategy() !== 'summary') return head;
		return summarizeResult(state, toolName, text, head, saved.ref, exec, worker);
	}

	/** The prompt that asks the worker for a digest of text it already produced. */
	function summaryPrompt(toolName, limit, text) {
		const body = text.length > SUMMARY_INPUT_MAX ? `${text.slice(0, SUMMARY_INPUT_MAX)}\n\n… [truncated for the digest]` : text;
		return [
			`You are a delegated ${TASKS.find((entry) => entry.task === 'read').label} working for a coding agent.`,
			`Earlier your \`${toolName}\` tool returned the text below to your caller, but it is too long (${text.length} characters) to hand over whole.`,
			`Write a technical digest of it. Keep names, paths, line numbers, identifiers, and exact key snippets; do not invent anything and do not ask questions.`,
			`Stay within ${limit} characters. Do not call any tool.`,
			'Text:',
			body,
		].join('\n');
	}

	/**
	 * Replace an over-budget result with a worker-written digest.
	 *
	 * The digest is always marked as one and keeps the spill hint, so the main
	 * agent knows the text was condensed and where the full copy lives. Any
	 * failure of the second pass falls back to the head/tail cut.
	 *
	 * It runs in `worker` — the session that produced the text — and not on a
	 * free pool slot: the prompt refers to an earlier call of that very session.
	 */
	async function summarizeResult(state, toolName, text, head, ref, exec, worker) {
		const limit = maxResultChars();
		const prefix = `[delegate-io: digest of ${text.length} characters; the full copy was saved (${ref.bytes} bytes). ${ref.retrievalHint}]\n\n`;
		try {
			const { text: digest } = await runJob(state, worker, toolName, {}, exec, undefined, {
				capture: 'answer',
				prompt: summaryPrompt(toolName, limit, text),
				verify: false,
				remember: true,
			});
			state.summarized += 1;
			const room = Math.max(0, limit - prefix.length);
			const kept = digest.length <= room ? digest : digest.slice(0, room);
			return `${prefix}${kept}${kept.length < digest.length ? '\n… [digest cut to the budget; the full copy was saved]' : ''}`;
		} catch (error) {
			state.summarizeFallbacks += 1;
			ctx.logger?.warn?.('delegate-io: digesting the %s result failed, keeping head and tail: %o', toolName, error);
			return head;
		}
	}

	/**
	 * The environment a worker session was created under. A worker pins the
	 * parent's permissions and working directory, so any change retires it.
	 */
	function environmentOf(root) {
		let mode = '';
		try {
			mode = ctx.get('sandboxPolicy')?.resolve({ session: root.session })?.mode ?? '';
		} catch {
			mode = '';
		}
		return `${mode}\u0000${root.session?.header?.cwd ?? ''}`;
	}

	/** Per-root-agent state keyed by SessionId. */
	const roots = new Map();

	try {
		ctx.get('settings')?.configure?.({ auto: true });
	} catch (error) {
		ctx.logger?.warn?.('delegate-io: registering the settings page policy failed: %o', error);
	}

	/** Whether one agent is a delegated child rather than a root agent. */
	function isChild(agent) {
		return agent?.session?.header?.origin === 'subagent';
	}

	/** Build the child agent options for one task type. */
	function agentOptionsFor(task, root) {
		const route = routeFor(task);
		if (route.enabled !== true) return undefined;
		const options = {};
		if (route.provider !== '' && route.model !== '') {
			options.provider = route.provider;
			options.model = route.model;
		}
		if (route.reasoningEffort !== '') options.reasoningEffort = route.reasoningEffort;
		if (options.provider === undefined) {
			const current = root?.model?.current?.();
			if (current?.provider !== undefined && current?.model !== undefined) {
				options.provider = current.provider;
				options.model = current.model;
				if (current.reasoningEffort !== undefined && options.reasoningEffort === undefined) {
					options.reasoningEffort = current.reasoningEffort;
				}
			}
		}
		return Object.keys(options).length === 0 ? undefined : options;
	}

	/** The worker instruction for one task type. */
	function persona(definition) {
		return (
			`You are a delegated ${definition.label} working for a coding agent. ` +
			`Execute the one task in this message by calling the named tool exactly once. ` +
			`The caller reads that tool's result itself, so do not restate it: reply with exactly "OK" ` +
			`and nothing else — no summary, no commentary, no markdown fences, no questions. ` +
			`Do not call send_message.`
		);
	}

	/**
	 * The message that asks one worker to produce a report about one path.
	 *
	 * The report is what the main agent receives instead of the content, so the
	 * instructions pin its shape: a short answer to the focus, an outline,
	 * verbatim snippets with locations copied from the tool, next steps, and an
	 * explicit list of what was not checked. Confidence is the only honesty the
	 * caller has, because a report cannot be verified like a file write.
	 */
	function inspectPrompt(args) {
		const lines = depthLines();
		const depth = args.depth === 'overview' || args.depth === 'thorough' ? args.depth : 'normal';
		const budget = DEPTH_LINES[depth];
		return [
			'You are a delegated file reader working for a coding agent that will not see the file contents itself.',
			`Inspect \`${args.path}\` by reading it with your own tools (read, glob, grep; for a directory, list it first). Never guess its content.`,
			`Focus: ${args.focus}`,
			`Reply with a report in exactly this shape and nothing else:`,
			'found: <1–3 sentences that answer the focus>',
			'structure: <the outline that matters: files, sections, symbols, each with its path or line>',
			`fragments: <at most ${budget} lines, each "path:line <text copied verbatim from the tool output>" — never paraphrase code>`,
			'where to look next: <paths or names a reader should open, verified by you>',
			'confidence: <high|medium|low> · not checked: <what you could not read or did not look at>',
			`Keep the whole report within ${Math.max(lines, budget) * 120} characters. Do not call send_message.`,
		].join('\n');
	}

	/**
	 * The message that opens one thinking turn.
	 *
	 * The worker has no tools and no conversation, so this envelope is all it
	 * knows. It may ask its caller for one fact at a time instead of reading
	 * anything itself; the answer arrives as the next message.
	 */
	function thinkPrompt(args) {
		const rounds = thinkMaxTurns();
		const askRule =
			rounds === 0
				? 'You may not ask anything: decide from the evidence below.'
				: `If exactly one fact is missing and the caller can state it, reply with {"need": "<that fact>"}. ` +
					`You may ask at most ${rounds} time${rounds === 1 ? '' : 's'}; each answer arrives as the next message.`;
		return [
			'You are the reasoning worker of a coding agent that runs without reasoning.',
			'You have no files, no tools, and no conversation: everything you know is below.',
			`Question: ${args.question}`,
			'Evidence supplied by the caller:',
			args.evidence,
			'',
			'Rules:',
			'- Decide from the evidence above. Do not speculate about files you cannot see.',
			`- ${askRule}`,
			'- When you can decide, reply with exactly one JSON object of this shape:',
			'{"diagnosis": "<1-3 sentences that answer the question>", "evidence": ["<the fact you relied on>"], "nextStep": "<one concrete action the caller can take now>", "risks": ["<what could go wrong>"], "confidence": "high|medium|low"}',
			'- Reply with that JSON only: no markdown fences, no prose before or after it.',
		].join('\n');
	}

	/**
	 * What the caller receives when the thinker stops to ask for a fact.
	 *
	 * A tool call cannot reach back into the running turn: the main agent gets
	 * this text only after the call settles, so the question travels as the
	 * result. The main agent answers it by calling again with the fact added to
	 * `evidence`, which is the only channel the protocol allows.
	 */
	function needText(args, need) {
		return [
			`delegate-io think: ${args.question}`,
			`the thinker needs one fact before deciding: ${need}`,
			'It read nothing on its own. Supply that fact as `evidence` and call delegate_think again.',
		].join('\n');
	}

	/** The caller-facing form of one decision. */
	function thoughtText(args, reply) {
		const lines = [`delegate-io think: ${args.question}`, `diagnosis: ${reply.diagnosis}`];
		if (reply.nextStep !== '') lines.push(`next step: ${reply.nextStep}`);
		return lines.join('\n');
	}

/** The message that asks one worker to perform one tool call. */
	function taskMessage(task, toolName, args) {
		const payload = JSON.stringify(args);
		if (task === 'write') {
			return [
				`Call the \`${toolName}\` tool exactly once with the arguments below.`,
				'Reproduce every character exactly: do not shorten, reformat, re-indent, or paraphrase any value.',
				'Call no other tool.',
				'Arguments (JSON):',
				payload,
				'Then reply with exactly OK.',
			].join('\n');
		}
		return [
			`Call the \`${toolName}\` tool exactly once with the arguments below.`,
			'Do not change the arguments and do not call any other tool.',
			'Arguments (JSON):',
			payload,
			'Then reply with exactly OK.',
		].join('\n');
	}

	/** Bound one worker activation by the configured timeout. */
	async function withTimeout(work, signal) {
		let timer;
		const timeout = new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('delegate-io: the worker did not answer in time')), timeoutMs());
		});
		try {
			return await Promise.race([work, timeout]);
		} finally {
			clearTimeout(timer);
			if (signal?.aborted) throw new Error('delegate-io: the delegated call was cancelled');
		}
	}

	/** Child session id -> { state, worker } for the turn observer. */
	const workersByChild = new Map();

	/** Cancel one worker's running turn. */
	function interruptWorker(state, childId) {
		try {
			ctx.subagents.interrupt?.(childId, { kind: 'ancestor', agent: state.agent });
		} catch (error) {
			ctx.logger?.warn?.('delegate-io: interrupting worker %s failed: %o', childId, error);
		}
	}

	/**
	 * Forget one worker's child session, keeping its per-task queue. The next
	 * call creates a fresh session, so a stale worker never leaks into later
	 * calls.
	 *
	 * Every replacement goes through here, and the reason is logged: a worker
	 * that is silently replaced looks like a stream of new writers, and there
	 * has to be a line in the log saying what spent it.
	 *
	 * @param state - the root agent's delegation state.
	 * @param worker - the task's worker record.
	 * @param reason - why this session is being dropped.
	 */
	function recycleChild(state, worker, reason = 'unspecified') {
		const childId = worker.childId;
		worker.childId = undefined;
		worker.jobs = 0;
		worker.environment = '';
		worker.observation = undefined;
		if (childId === undefined) return;
		state.recycled += 1;
		state.recycleReasons.set(reason, (state.recycleReasons.get(reason) ?? 0) + 1);
		ctx.logger?.info?.('delegate-io: replacing the %s worker #%d %s (%s)', worker.task, worker.slot ?? 0, childId, reason);
		workersByChild.delete(childId);
		try {
			Promise.resolve(ctx.subagents.drainChildren?.(state.agent, [childId])).catch(() => {});
		} catch {
			// The child may already be gone.
		}
	}

	/** Retire every worker of one root, releasing their child sessions. */
	function recycleAll(state) {
		for (const worker of allWorkers(state)) recycleChild(state, worker, 'root agent released');
		state.workers.clear();
	}

	/**
	 * Keep the worker of a task the user just switched off.
	 *
	 * Switching delegation off must not replace the worker: the replacement
	 * trigger is the worker's own context limit and nothing else. The resident
	 * child simply stays until the task is switched back on (it then serves the
	 * next call with its history intact) or until its limit is spent.
	 *
	 * @param state - the root agent's delegation state.
	 * @param task - the task the caller just disabled.
	 */
	function retireIdleWorker(state, task) {
		const pool = state.workers.get(task);
		if (pool === undefined) return;
		for (const worker of pool.workers) {
			if (worker.childId === undefined) continue;
			ctx.logger?.info?.('delegate-io: %s delegation is off; keeping worker %s resident', task, worker.childId);
		}
	}

	/**
	 * A worker replies with `OK`; the answer is the tool result it produced.
	 * The observer takes the last `tool/result` of the worker's current turn,
	 * so the outcome never depends on the worker restating it.
	 *
	 * A report job (`delegate_inspect`, a summary pass) captures the worker's
	 * own answer instead, and records whether the worker called any tool: a
	 * report that was never grounded in a tool call is refused by its caller.
	 */
	ctx.on('session/event', (session, event) => {
		const entry = workersByChild.get(session.id);
		if (entry === undefined) return;
		const observation = entry.worker.observation;
		if (observation === undefined || observation.settled) return;
		if (event.type === 'assistant/message') {
			observation.answer = contentText(event.data?.message?.content);
			return;
		}
		if (event.type === 'tool/result') {
			observation.usedTool = true;
			observation.text = contentText(event.data?.message?.content);
			observation.failed = event.data?.error !== undefined || event.data?.message?.isError === true;
			return;
		}
		if (event.type === 'turn/end' && observation.finish !== undefined) observation.finish();
	});

	/** Run one call as the first turn of a new worker session. */
	async function startWorkerJob(state, worker, prompt, signal, capture) {
		const root = state.agent;
		const definition = TASKS.find((entry) => entry.task === worker.task);
		const cwd = root.session?.header?.cwd;
		const options = agentOptionsFor(worker.task, root);
		worker.observation = { text: '', answer: '', failed: false, usedTool: false, settled: false };
		let activation;
		let turnSettled = false;
		try {
			activation = await ctx.subagents.startActivation({
				provider: subagentProvider(),
				label: `delegate-io ${definition.label}`,
				delivery: 'caller',
				signal,
				request: {
					parent: root,
					prompt: [{ type: 'text', text: prompt }],
					...(cwd === undefined ? {} : { cwd }),
					...(options === undefined ? {} : { agentOptions: options }),
				},
			});
			worker.childId = activation.childId;
			worker.environment = environmentOf(root);
			workersByChild.set(activation.childId, { state, worker });
			await withTimeout(activation.result, signal);
			// The activation settled, so this first turn is over: later calls may
			// reuse the child without waiting for a `turn/end` that already passed.
			turnSettled = true;
			const { failed, usedTool, answer, text } = worker.observation;
			const selected = capture === 'answer' ? answer : text;
			if (selected.trim() === '') throw new Error(`delegate-io: the ${definition.label} returned no tool result`);
			return { text: selected, failed, usedTool, turnSettled };
		} finally {
			worker.observation = undefined;
			if (activation !== undefined) await Promise.resolve(activation.dispose?.()).catch(() => {});
		}
	}

	/** Send one call to a resident worker session and await its tool result. */
	async function continueWorkerJob(state, worker, prompt, signal, capture) {
		const root = state.agent;
		const childId = worker.childId;
		const definition = TASKS.find((entry) => entry.task === worker.task);
		const job = { turnSettled: false };
		let settle;
		let fail;
		const answer = new Promise((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const observation = {
			text: '',
			answer: '',
			failed: false,
			usedTool: false,
			settled: false,
			job,
			timer: undefined,
			finish() {
				if (this.settled) return;
				this.settled = true;
				this.job.turnSettled = true;
				clearTimeout(this.timer);
				settle({ failed: this.failed, usedTool: this.usedTool });
			},
			abort(reason) {
				if (this.settled) return;
				this.settled = true;
				clearTimeout(this.timer);
				fail(reason);
			},
		};
		observation.timer = setTimeout(() => {
			observation.abort(new Error('delegate-io: the worker did not answer in time'));
			interruptWorker(state, childId);
		}, timeoutMs());
		worker.observation = observation;
		const onAbort = () => {
			observation.abort(new Error('delegate-io: the delegated call was cancelled'));
			interruptWorker(state, childId);
		};
		signal?.addEventListener?.('abort', onAbort, { once: true });
		try {
			await ctx.subagents.sendMessage(root, childId, [{ type: 'text', text: prompt }], { signal });
			// Bound the wait itself, not just the send: a worker that accepted the
			// message but never closed its turn would otherwise hang this call
			// forever, and the observation timer is cleared in `finally` before the
			// next call can rely on it.
			const settled = await withTimeout(answer, signal);
			const text = capture === 'answer' ? observation.answer : observation.text;
			if (text.trim() === '') throw new Error(`delegate-io: the ${definition.label} returned no tool result`);
			return { text, failed: settled.failed, usedTool: settled.usedTool, turnSettled: job.turnSettled };
		} finally {
			signal?.removeEventListener?.('abort', onAbort);
			clearTimeout(observation.timer);
			if (worker.observation === observation) worker.observation = undefined;
		}
	}

	/**
	 * The per-root worker pool for one task, created on first use.
	 *
	 * The map is `task -> pool`, not `task -> worker`: the notice filter and
	 * the status report enumerate it, and `workersByChild` still resolves one
	 * concrete record, so the observer needs no change.
	 *
	 * Creation is lazy in both layers. The pool is built on the first call of
	 * the task, and its members are plain records — a child session is started
	 * only by `startWorkerJob`, when a call actually lands on that slot. A
	 * serial task therefore uses slot 0 forever and never wakes the others.
	 *
	 * @returns {{ task: string, workers: any[] }} The pool, never empty.
	 */
	function workerFor(state, task) {
		let pool = state.workers.get(task);
		if (pool === undefined) {
			const size = WORKERS_PER_TASK[task] ?? 1;
			pool = {
				task,
				workers: Array.from({ length: size }, (_unused, slot) => ({
					task,
					slot,
					childId: undefined,
					jobs: 0,
					lastJobAt: 0,
					environment: '',
					contextTokens: 0,
					chain: Promise.resolve(),
					pending: 0,
					observation: undefined,
				})),
			};
			state.workers.set(task, pool);
		}
		return pool;
	}

	/**
	 * Every worker record of one root, across all pools.
	 *
	 * The notice filter and the teardown used to iterate the map directly and
	 * would now walk pool objects instead of workers, silently leaving slots 1
	 * and 2 unmanaged — the settlement notices of those slots would reach the
	 * model again.
	 *
	 * @param {{ workers: Map<string, { workers: any[] }> }} state Root-agent state.
	 * @returns {any[]} All worker records.
	 */
	function allWorkers(state) {
		return [...state.workers.values()].flatMap((pool) => pool.workers);
	}

	/**
	 * Pick the pool member with the fewest queued calls.
	 *
	 * Ties go to the lowest slot, so a serial task keeps landing on slot 0 and
	 * its history accumulates instead of being spread thin. Choosing at
	 * dispatch time is what turns the pool into parallelism: without it every
	 * call would still queue on one chain.
	 */
	function pickWorker(pool) {
		let selected = pool.workers[0];
		for (const worker of pool.workers) {
			if (worker.pending < selected.pending) selected = worker;
		}
		return selected;
	}

	/**
	 * The pool member that owns one file path, for the `write` task.
	 *
	 * Two delegated mutations of the same file must never run at once. Each job
	 * takes its `before` snapshot inside `runJob`, so a parallel pair would both
	 * predict from the same content; the second one's verification compares the
	 * file against that stale prediction and "repairs" it by rewriting the whole
	 * file — silently dropping the first edit. Serialising on one chain is what
	 * used to make this impossible, and the pool must keep it.
	 *
	 * Deriving the slot from the path gives both properties: the same file
	 * always lands on the same chain (so calls serialise, and the snapshot is
	 * taken after the previous edit) while different files spread over the pool
	 * and still run in parallel. A hash collision only costs parallelism, never
	 * ordering.
	 *
	 * @param {{ workers: any[] }} pool The task's pool.
	 * @param {unknown} filePath `args.file_path` of the call, when present.
	 * @returns {any} The slot that owns this path, or the least busy one.
	 */
	function fileWorker(pool, filePath) {
		if (typeof filePath !== 'string' || filePath === '') return pickWorker(pool);
		let hash = 0;
		for (let index = 0; index < filePath.length; index += 1) {
			hash = (hash * 31 + filePath.charCodeAt(index)) >>> 0;
		}
		return pool.workers[hash % pool.workers.length];
	}

	/**
	 * Serialise everything that touches one file, across the whole pool.
	 *
	 * Slot affinity alone is not a guarantee: it hashes the literal
	 * `file_path`, so `a.txt`, `./a.txt` and `C:\\ws\\a.txt` would land on
	 * different slots and run their writes at the same time — the exact race
	 * this exists to prevent. Each job snapshots `before` inside `runJob` and
	 * later repairs the file from that prediction, so two concurrent mutations
	 * of one file can silently drop one of them.
	 *
	 * This map is the guarantee, keyed by the *canonical* path: whichever slot
	 * a call lands on, a second call for the same file waits for the first to
	 * finish, verification included. Slots stay as they are, so history and
	 * the pool's parallelism on different files are unaffected.
	 *
	 * @type {Map<string, Promise<unknown>>} Key -> tail of that file's queue.
	 */
	const fileGates = new Map();

	/**
	 * The canonical key of one file path, or undefined when it is not a path.
	 *
	 * Relative paths are resolved against the root agent's working directory
	 * and lower-cased on Windows, because the same file reaches the tool under
	 * several spellings and `a.txt`/`./a.txt` must share one gate.
	 *
	 * @param {any} state The root agent's delegation state.
	 * @param {unknown} filePath `args.file_path` of the call.
	 * @returns {string | undefined} The key, or undefined when there is none.
	 */
	function fileKeyOf(state, filePath) {
		if (typeof filePath !== 'string' || filePath === '') return undefined;
		const cwd = state.agent?.session?.header?.cwd;
		let key;
		try {
			key = typeof cwd === 'string' && cwd !== '' ? resolvePath(cwd, filePath) : resolvePath(filePath);
		} catch {
			// A path the platform cannot resolve is still a distinct file; fall
			// back to the literal text rather than dropping the guard.
			key = filePath;
		}
		return process.platform === 'win32' ? key.toLowerCase() : key;
	}

	/**
	 * Run `work` while holding the exclusive gate of one file key.
	 *
	 * Callers queue on the previous tail instead of a timer: the next holder is
	 * woken by the previous release, so ordering is strict and no polling is
	 * involved. The map entry is dropped when the queue drains, so a long
	 * session does not accumulate one promise per file it ever edited.
	 *
	 * @param {string} key Canonical file key.
	 * @param {() => Promise<any>} work The exclusive section.
	 * @returns {Promise<any>} The result of `work`.
	 */
	async function withFileGate(key, work) {
		const previous = fileGates.get(key) ?? Promise.resolve();
		let release;
		const held = new Promise((resolveDone) => {
			release = resolveDone;
		});
		const tail = previous.then(() => held);
		fileGates.set(key, tail);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (fileGates.get(key) === tail) fileGates.delete(key);
		}
	}

	/**
	 * Run the authoritative tool directly, still under the file's gate.
	 *
	 * The fallback path used to bypass the queue entirely, so a direct `write`
	 * could race a delegated `edit` of the same file. It keeps the same
	 * exclusivity now; the lock is re-entered by a different call, never
	 * nested, because the delegated attempt has already released it.
	 *
	 * @param {any} state The root agent's delegation state.
	 * @param {string} task The task type that owns the tool.
	 * @param {unknown} args The tool arguments.
	 * @param {any} exec Tool execution context.
	 * @param {any} real The authoritative tool.
	 * @returns {Promise<any>} The tool's own result.
	 */
	function executeDirect(state, task, args, exec, real) {
		const key = task === 'write' ? fileKeyOf(state, args?.file_path) : undefined;
		if (key === undefined) return real.execute(args, exec);
		return withFileGate(key, () => real.execute(args, exec));
	}

	/**
	 * Find the live Agent of one resident worker.
	 *
	 * The plugin disposes the activation after every job and keeps only the
	 * durable child id, so the Agent is read back from the runtime registry the
	 * subagent service itself uses (`ctx.agents.list()`).
	 *
	 * @returns The live Agent, or undefined once the child is gone.
	 */
	function liveWorkerAgent(childId) {
		if (childId === undefined) return undefined;
		const direct = ctx.agents?.get?.(childId);
		if (direct !== undefined) return direct;
		try {
			return (ctx.agents?.list?.() ?? []).find((agent) => agent.id === childId);
		} catch (error) {
			ctx.logger?.warn?.('delegate-io: listing agents for %s failed: %o', childId, error);
			return undefined;
		}
	}

	/**
	 * Size of one worker's context, in tokens, excluding prompt cache.
	 *
	 * The token meter reports several numbers and only some of them measure the
	 * conversation:
	 *
	 * - `contextPressure().pressureTokens` is provider usage, and the runtime
	 *   defines it as `input + cacheRead + cacheWrite`. Cache traffic is not
	 *   context, so using it here made every cached worker look many times its
	 *   real size and forced a recycle on nearly every call.
	 * - `measure().surfaceTokens` prices the model-visible surface itself:
	 *   messages, tool results, and files, with no usage sample and no cache
	 *   component. That is what a context limit has to bound.
	 *
	 * The tools and system prompt of the routed request are not part of the
	 * surface; the caller adds them from the request envelope when it can.
	 *
	 * @returns Context tokens, or 0 when the meter is unavailable.
	 */
	function contextTokensOf(session) {
		try {
			const meter = ctx.get('tokenMeter');
			const surface = Number(meter?.measure?.(session)?.surfaceTokens);
			if (Number.isFinite(surface) && surface >= 0) return Math.floor(surface);
			// A meter without `measure` cannot answer without cache, so report
			// nothing rather than a value the limit must not trust.
			return 0;
		} catch (error) {
			ctx.logger?.warn?.('delegate-io: measuring a worker context failed: %o', error);
			return 0;
		}
	}

	/**
	 * Re-pin a resident worker to the parent's current permission scope.
	 *
	 * A worker session is created under the parent's sandbox mode and working
	 * directory. When either changes, the worker used to be thrown away and
	 * restarted, which spawned a fresh child session on every sandbox or
	 * project switch. The scope is re-applied instead: the worker keeps its
	 * history and simply runs the next task under the new scope.
	 *
	 * @param state - the root agent's delegation state.
	 * @param worker - the task's worker record.
	 */
	function refreshWorkerEnvironment(state, worker) {
		if (worker.childId === undefined) return;
		const environment = environmentOf(state.agent);
		if (worker.environment === environment) return;
		const previous = worker.environment;
		worker.environment = environment;
		const child = liveWorkerAgent(worker.childId);
		if (child === undefined) return;
		try {
			ctx.get('workingDirectory')?.set?.(child, state.agent.session?.header?.cwd ?? '');
			ctx.logger?.info?.(
				'delegate-io: re-pinned the %s worker to the parent environment (was %s)',
				worker.task,
				previous,
			);
		} catch (error) {
			ctx.logger?.warn?.('delegate-io: re-pinning the %s worker failed: %o', worker.task, error);
		}
	}

	/**
	 * Compact one resident worker whose context passed its per-worker limit.
	 *
	 * The limit is the only thing that ever replaces a worker. Everything short
	 * of a spent limit keeps the session: a worker that is already below its
	 * limit, one whose history holds nothing compactable, and even a compaction
	 * that failed or has no backend — those leave the session intact and are
	 * reported, because restarting it would not make the next task smaller.
	 *
	 * @param state - the root agent's delegation state.
	 * @param worker - the task's worker record, possibly not started yet.
	 * @param signal - cancellation of the delegated call.
	 */
	async function compactWorkerIfOverLimit(state, worker, signal) {
		const limit = contextLimitOf(worker.task);
		if (limit <= 0 || worker.childId === undefined) return;
		const child = liveWorkerAgent(worker.childId);
		if (child === undefined) {
			// The runtime no longer exposes this child. That is not a policy
			// reason to start a new session, so the record is kept as it is and
			// the situation is reported; only a spent context limit replaces a
			// worker.
			ctx.logger?.warn?.(
				'delegate-io: the %s worker session %s is missing from the registry; keeping its record',
				worker.task,
				worker.childId,
			);
			return;
		}
		const before = contextTokensOf(child.session);
		worker.contextTokens = before;
		if (before < limit) return;
		const compaction = ctx.get('compaction');
		if (compaction?.compactNow === undefined) {
			ctx.logger?.warn?.(
				'delegate-io: the %s worker is at %d tokens (limit %d) with no compaction backend; keeping its session',
				worker.task,
				before,
				limit,
			);
			return;
		}
		try {
			const result = await compaction.compactNow(child, signal);
			const after = contextTokensOf(child.session);
			worker.contextTokens = after;
			state.compacted += 1;
			ctx.logger?.info?.(
				'delegate-io: compacted the %s worker from %d to %d tokens%s',
				worker.task,
				before,
				after,
				result === null ? ' (nothing compactable)' : '',
			);
			// A spent limit is the one replacement trigger. `after` still at or
			// above the limit means the history cannot be reduced, so the only way
			// to stay under it is a fresh session.
			if (after >= limit) recycleChild(state, worker, `context limit spent (${after} >= ${limit})`);
		} catch (error) {
			if (signal?.aborted === true) throw error;
			ctx.logger?.warn?.('delegate-io: compacting the %s worker failed; keeping its session: %o', worker.task, error);
			state.compactionFailures += 1;
		}
	}

	/**
	 * Run one delegated call in the task's worker session, creating it on demand.
	 *
	 * A worker is a long-lived resident session: once started it serves every
	 * later call of its task and is replaced only when its context limit is
	 * spent (see `compactWorkerIfOverLimit`). Idle time, a changed sandbox mode
	 * or working directory, a spent call counter, or one failed call must not
	 * retire it — restarting a worker costs a whole new child session, and the
	 * reader/writer history it accumulated is what makes later calls cheap.
	 */
	async function runJob(state, worker, toolName, args, exec, real, jobOptions = {}) {
		const task = worker.task;
		const definition = TASKS.find((entry) => entry.task === task);
		const capture = jobOptions.capture === 'answer' ? 'answer' : 'tool';
		// A resident worker's pinned permissions and working directory may have
		// drifted from the parent's; re-pin them instead of starting over, so the
		// work still runs under the parent's current scope.
		refreshWorkerEnvironment(state, worker);
		// The one and only replacement trigger: the worker's own context limit.
		await compactWorkerIfOverLimit(state, worker, exec.signal);
		const prompt =
			typeof jobOptions.prompt === 'string'
				? jobOptions.prompt
				: `${persona(definition)}\n\n${taskMessage(task, toolName, args)}`;
		state.started += 1;
		let turnSettled = false;
		try {
			const plan = jobOptions.verify === false ? undefined : await prepareVerification(state, toolName, args, exec.signal);
			const outcome =
				worker.childId === undefined
					? await startWorkerJob(state, worker, prompt, exec.signal, capture)
					: await continueWorkerJob(state, worker, prompt, exec.signal, capture);
			const { text, failed, usedTool } = outcome;
			turnSettled = outcome.turnSettled === true;
			worker.jobs += 1;
			worker.lastJobAt = Date.now();
			if (capture === 'answer' && usedTool !== true && jobOptions.requireTool !== false) {
				throw new Error(`delegate-io: the ${definition.label} answered without calling a tool`);
			}
			const repaired = await settleVerification(state, toolName, args, real, plan, failed, exec);
			state.completed += 1;
			const finalText = repaired ?? text;
			return jobOptions.remember === true ? { text: finalText, failed } : capResult(state, toolName, finalText, exec, worker);
		} catch (error) {
			// A failed call never replaces the worker. A tool error, a refused
			// verification, an answer without a tool call, and even a turn that
			// never closed are all reported and left to the context limit: the
			// replacement trigger is the worker's own context, nothing else.
			state.failures += 1;
			state.lastError = error instanceof Error ? error.message : String(error);
			ctx.logger?.warn?.(
				'delegate-io: the %s worker call failed%s; keeping its session: %o',
				task,
				turnSettled ? '' : ' with an unsettled turn',
				error,
			);
			throw error;
		}
	}

	/**
	 * Record one worker outcome for the escalate gate.
	 *
	 * Two separate facts matter here, and only the second one used to exist:
	 *
	 * - `failuresByTool` counts consecutive failures of ONE tool, which is the
	 *   "you typed the path wrong twice" signal.
	 * - `failures` counts failed delegated calls overall. A problem that keeps
	 *   going wrong while the failing tool keeps changing — a worker storm, a
	 *   set of hypotheses that each fail differently — is invisible to the
	 *   per-tool counter, because every new failure resets it to 1.
	 *
	 * The caller reads `state.failures` to decide whether a run of attempts is
	 * not converging, which is the case the thinker exists for.
	 *
	 * @param state - the root agent's delegation state.
	 * @param toolName - the tool whose call just failed, if a call failed.
	 * @param failed - whether this outcome was a failure.
	 * @returns {number} The current consecutive failure count for the tool.
	 */
	function noteOutcome(state, toolName, failed) {
		const count = failed === true ? (state.failuresByTool.get(toolName) ?? 0) + 1 : 0;
		if (count === 0) state.failuresByTool.delete(toolName);
		else state.failuresByTool.set(toolName, count);
		return count;
	}

	/**
	 * The escalation hint, or an empty string when the thinker cannot be used.
	 *
	 * A hint that tells the model about `delegate_think` while the tool is
	 * switched off is worse than no hint: the model is invited to a tool it
	 * does not have, and the real advice ("turn the thinker on, or stop
	 * guessing") never reaches it. The disabled state is therefore named
	 * explicitly instead of being silently skipped.
	 */
	function escalateHint(reason) {
		if (routeFor('think').enabled === true) {
			return (
				`\n\n[delegate-io: ${reason} — this is the point for delegate_think: ` +
				`pass the exact errors above as evidence and let it decide]`
			);
		}
		return (
			`\n\n[delegate-io: ${reason} — delegate_think would decide this, but the thinking worker ` +
			`is switched off (thinkEnabled). Turn it on in the plugin settings, or change approach ` +
			`instead of retrying the same step]`
		);
	}

	/**
	 * Append the escalate hint to one direct result when the caller has failed
	 * enough times to stop guessing.
	 *
	 * Two independent triggers, because the failures that matter differ:
	 *
	 * - the same tool failing over and over (`thinkEscalateAfter`);
	 * - many failed delegated calls in total, whatever the tool — the case
	 *   where every attempt fails differently and the per-tool counter never
	 *   climbs high enough.
	 *
	 * The hint is appended to both a direct fallback result and a successful
	 * delegated one: the caller needs to hear it no matter which way the last
	 * call went.
	 *
	 * @param value - the tool result the authoritative tool produced.
	 * @param real - the authoritative tool, used to render the result as text.
	 * @param toolName - the tool that just ran.
	 * @param count - consecutive failures of that tool.
	 * @param state - the root agent's delegation state; omitted on the path that
	 *   has no worker failures to count (see `overallFailureHint`).
	 * @returns The result, extended with the hint when a trigger fires.
	 */
	function hintResult(value, real, toolName, count, state) {
		if (thinkEscalateAfter() === 0) return value;
		const sameTool = count >= thinkEscalateAfter();
		const overall = overallFailureHint(state);
		if (sameTool !== true && overall === '') return value;
		if (value === null || typeof value !== 'object') return value;
		const blocks = real.output?.render?.(undefined, value);
		if (!Array.isArray(blocks)) return value;
		const body = blocks
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('');
		if (body === '') return value;
		const reason =
			sameTool === true ? `"${toolName}" has failed ${count} times in a row` : overall;
		if (state !== undefined) state.escalated += 1;
		return { 'delegate-io': { text: `${body}${escalateHint(reason)}` } };
	}

	/**
	 * The "this is not converging" hint for one root agent, or an empty string.
	 *
	 * Counted per attempt, not per tool: after `THINKER_ATTEMPT_BUDGET` failed
	 * delegated calls the problem has outlived several different approaches, so
	 * another retry is unlikely to be the answer. The counter resets on every
	 * successful call, so a healthy session never accumulates it.
	 *
	 * @param state - the root agent's delegation state, or undefined.
	 * @returns The hint text, or an empty string when no threshold is reached.
	 */
	function overallFailureHint(state) {
		if (thinkEscalateAfter() === 0 || state === undefined) return '';
		if (state.failures < THINKER_ATTEMPT_BUDGET) return '';
		return `${state.failures} delegated calls have failed with different errors`;
	}

	/**
	 * Queue one call on its task's pool; different tasks stay independent.
	 *
	 * A file mutation holds that file's gate for the whole job (see
	 * `withFileGate`), so no second mutation of the same file can run
	 * concurrently even if it lands on another slot. Slot selection keeps the
	 * hash affinity so a repeatedly edited file keeps its warm history.
	 */
	function dispatch(state, task, toolName, args, exec, real, jobOptions) {
		const pool = workerFor(state, task);
		const worker = task === 'write' ? fileWorker(pool, args?.file_path) : pickWorker(pool);
		const key = task === 'write' ? fileKeyOf(state, args?.file_path) : undefined;
		worker.pending += 1;
		// Snapshot the slot's tail now, so the slot order is fixed at dispatch
		// time and the gate only adds the file-level exclusion around the job.
		const slotTail = worker.chain;
		const runOnSlot = () => slotTail.then(() => runJob(state, worker, toolName, args, exec, real, jobOptions));
		const run = key === undefined ? runOnSlot() : withFileGate(key, runOnSlot);
		worker.chain = run.then(
			() => {},
			() => {},
		);
		const settle = () => {
			worker.pending -= 1;
		};
		run.then(settle, settle);
		return run;
	}

	// A worker's settlement notice repeats what the tool result already carried.
	// Drop it from the model's step. The batch may become empty, and that is
	// correct: the loop then continues the running turn with no new input, so
	// the model still answers after its tool calls. Rejecting the step here
	// closed the turn as `blocked` before any request and left the chat silent.
	ctx.on('agent/pre-step', async (payload, next) => filterPreStep(roots.get(payload.agent.id), await next()));

	/** Register the scoped tool clones that route one task type through its worker. */
	function mount(state, task) {
		// The clone is registered even while the task is switched off: the enable
		// switch is read per call, so a session that was started with delegation
		// disabled must still pick it up when the user turns it on.
		const definition = TASKS.find((entry) => entry.task === task);
		// A global task shadows nothing: its tool is registered once, below.
		if (definition.global === true) return;
		for (const toolName of definition.tools) {
			const real = ctx.tools.get(toolName, state.agent);
			if (real === undefined) {
				ctx.logger?.warn?.('delegate-io: tool "%s" is not registered, skipping its delegation', toolName);
				continue;
			}
			state.tools.set(toolName, real);
			const shadow = {
				name: real.name,
				description: `${real.description} Execution may be delegated to a subagent that returns the tool output.`,
				parameters: real.parameters,
				...(real.deferLoading === true ? { deferLoading: true } : {}),
				...(real.timeoutMs === undefined ? {} : { timeoutMs: real.timeoutMs }),
				output: {
					schema: delegatedValueSchema(real),
					render(args, value) {
						if (value !== null && typeof value === 'object' && value['delegate-io'] !== undefined) {
							return [{ type: 'text', text: value['delegate-io'].text }];
						}
						return real.output.render(args, value);
					},
				},
				...(real.presentCall === undefined ? {} : { presentCall: (args) => real.presentCall(args) }),
				isConcurrencySafe: () => true,
				async execute(args, exec) {
					const caller = exec.agent;
					if (caller === undefined || caller.id !== state.agent.id) return real.execute(args, exec);
					if (routeFor(task).enabled !== true) {
						retireIdleWorker(state, task);
						return real.execute(args, exec);
					}
					try {
						const text = await dispatch(state, task, toolName, args, exec, real);
						// A successful call means the session is converging again, so the
						// attempt budget starts over; otherwise an old run of failures
						// would keep nagging long after the problem was solved.
						state.failures = 0;
						noteOutcome(state, toolName, false);
						// The hint still rides a successful result: the model has to hear
						// that its retries are not converging even when this call worked.
						return hintResult({ 'delegate-io': { text } }, shadow, toolName, 0);
					} catch (error) {
						if (fallbackToDirect() !== true) throw error;
						// A failed write verification is already repaired by the
						// authoritative tool; re-running an edit here could apply it twice.
						if (error?.delegateIoVerification === true) throw error;
						ctx.logger?.warn?.('delegate-io: %s delegation failed, running the tool directly: %o', toolName, error);
						state.fallbacks += 1;
						state.lastError = String(error?.message ?? error);
						const count = noteOutcome(state, toolName, true);
						const direct = await executeDirect(state, task, args, exec, real);
						return hintResult(direct, real, toolName, count, state);
					}
				},
			};
			try {
				state.disposers.push(state.agent.ctx.tools.register(shadow));
				state.mounted.push(toolName);
			} catch (error) {
				ctx.logger?.warn?.('delegate-io: registering "%s" for the root agent failed: %o', toolName, error);
			}
		}
	}

	/** Start tracking one root agent, once. */
	function track(agent) {
		if (agent === undefined || isChild(agent)) return;
		if (roots.has(agent.id)) return;
		const state = {
			agent,
			disposers: [],
			mounted: [],
			tools: new Map(),
			workers: new Map(),
			started: 0,
			completed: 0,
			fallbacks: 0,
			truncated: 0,
			summarized: 0,
			summarizeFallbacks: 0,
			inspected: 0,
			verified: 0,
			repaired: 0,
			unverified: 0,
			thought: 0,
			thinkAsks: 0,
			thinkFailed: 0,
			escalated: 0,
			compacted: 0,
			compactionFailures: 0,
			failures: 0,
			recycled: 0,
			recycleReasons: new Map(),
			failuresByTool: new Map(),
			lastError: null,
		};
		roots.set(agent.id, state);
		for (const task of TASK_KEYS) mount(state, task);
		if (state.mounted.length > 0) {
			ctx.logger?.info?.('delegate-io: agent %s delegates %s', agent.id, state.mounted.join(', '));
		}
		agent.ctx.effect(
			() => () => {
				if (roots.get(agent.id) === state) roots.delete(agent.id);
				try {
					recycleAll(state);
				} catch (error) {
					ctx.logger?.warn?.('delegate-io: releasing the workers of agent %s failed: %o', agent.id, error);
				}
				for (const dispose of state.disposers) {
					try {
						dispose();
					} catch (error) {
						ctx.logger?.warn?.('delegate-io: releasing a tool registration failed: %o', error);
					}
				}
				state.disposers.length = 0;
			},
			'delegate-io: agent lifetime',
		);
	}

	/** The global tools this plugin registers; `delegate_io_status` reports these. */
	const GLOBAL_TOOLS = ['delegate_think', 'delegate_inspect', 'delegate_io_status'];

	/**
	 * Report whether each of this plugin's global tools is visible to one agent.
	 *
	 * A model cannot read its own tool schema list, so "the tool is not
	 * available to me" is otherwise unverifiable from inside a session — the
	 * exact claim that went wrong during a long debugging session, where the
	 * tool was present in every request header while the agent reported it
	 * missing. The registry is the authority: ask it the same way an executor
	 * does, with the calling agent as the viewing scope.
	 *
	 * A missing tool has two very different causes and this tells them apart:
	 * `registered: false` means this plugin instance never registered it (a
	 * stale module below the running Host), while `registered: true` with
	 * `visible: false` means something masked it for that agent scope.
	 *
	 * @param caller - the agent that invoked the status tool, if any.
	 * @returns Per-tool registration and visibility, plus a short summary.
	 */
	function toolVisibility(caller) {
		const tools = ctx.get('tools');
		const report = {};
		for (const name of GLOBAL_TOOLS) {
			let registered = false;
			let visible = false;
			let error;
			try {
				// The global view (no scope) answers "is it registered at all";
				// the agent view answers "does this agent resolve it".
				registered = tools?.get?.(name) !== undefined;
				visible = caller === undefined ? registered : tools?.get?.(name, caller) !== undefined;
			} catch (thrown) {
				error = String(thrown?.message ?? thrown);
			}
			report[name] = { registered, visible, ...(error === undefined ? {} : { error }) };
		}
		const missing = Object.entries(report)
			.filter(([, entry]) => entry.registered !== true || entry.visible !== true)
			.map(([name]) => name);
		return {
			tools: report,
			summary:
				missing.length === 0
					? 'every global tool is registered and visible to this agent'
					: `not reachable from this agent: ${missing.join(', ')}`,
		};
	}

	ctx.tools.register({
		name: 'delegate_think',
		description:
			'Escalate to a reasoning worker when reasoning is the bottleneck: after the same failure twice, ' +
			'when two approaches conflict, before an irreversible change, or when the request needs a design decision. ' +
			'The thinker sees only the evidence you supply and may ask you one or two clarifying questions, ' +
			'so answer them with exact facts. Do not use it for routine steps you can complete directly.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				question: { type: 'string', description: 'What must be decided, in one or two sentences.' },
				evidence: {
					type: 'string',
					description: 'Exact errors, paths, outputs, and attempts. Verbatim from the tool results, never a paraphrase.',
				},
			},
			required: ['question', 'evidence'],
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args, exec) {
			const caller = exec.agent;
			const state = caller === undefined ? undefined : roots.get(caller.id);
			if (state === undefined) throw new Error('delegate-io: delegate_think is available to the main agent only');
			if (routeFor('think').enabled !== true) throw new Error('delegate-io: the thinking worker is switched off');
			state.thought += 1;
			const { text } = await dispatch(state, 'think', 'delegate_think', args, exec, undefined, {
				capture: 'answer',
				prompt: thinkPrompt(args),
				verify: false,
				remember: true,
				requireTool: false,
			});
			const reply = parseThinkReply(text);
			if (reply === undefined) {
				state.thinkFailed += 1;
				throw new Error('delegate-io: the thinker replied without a valid decision object');
			}
			if (reply.need !== undefined) {
				state.thinkAsks += 1;
				return { text: needText(args, reply.need) };
			}
			return { text: thoughtText(args, reply) };
		},
	});

	ctx.tools.register({
		name: 'delegate_inspect',
		description:
			'Ask the delegated file-reading worker for a report about one path instead of raw content. ' +
			'The report holds a short answer to `focus`, a structure outline, verbatim snippets with line locations, ' +
			'where to look next, and what the worker did not check. Use this for a survey; use `read` when exact text is required.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				path: { type: 'string', description: 'File, directory, or URI to inspect.' },
				focus: { type: 'string', description: 'What the report must answer, e.g. "how the tool registry is wired".' },
				depth: {
					type: 'string',
					enum: ['overview', 'normal', 'thorough'],
					description: 'How much verbatim snippet detail to include.',
				},
			},
			required: ['path', 'focus'],
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		async execute(args, exec) {
			const caller = exec.agent;
			const state = caller === undefined ? undefined : roots.get(caller.id);
			if (state === undefined) throw new Error('delegate-io: delegate_inspect is available to the main agent only');
			if (!inspectEnabled()) throw new Error('delegate-io: delegate_inspect is switched off');
			if (routeFor('read').enabled !== true) throw new Error('delegate-io: read delegation is switched off, so delegate_inspect cannot run');
			const text = await dispatch(state, 'read', 'delegate_inspect', args, exec, undefined, {
				capture: 'answer',
				prompt: inspectPrompt(args),
				verify: false,
				remember: true,
			});
			state.inspected += 1;
			const limit = inspectMaxChars();
			const report = `delegate-io inspect: ${args.path}\n${text.text}`;
			if (limit <= 0 || report.length <= limit) return { text: report };
			const saved = await saveSpill(state, 'delegate_inspect', report, exec, `delegate_inspect report for ${args.path}`);
			if (saved.ref === undefined) {
				ctx.logger?.warn?.('delegate-io: spilling the inspect report failed, keeping it whole: %o', saved.error);
				return { text: report };
			}
			return { text: budgetText(report, limit, saved.ref) };
		},
	});

	ctx.tools.register({
		name: 'delegate_io_status',
		description: 'Report the live state of the delegate-io plugin: delegated tools, tool visibility for this agent, workers, context limits and compactions, result spills, digests, reports, write verifications, and failures.',
		parameters: {},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: {} },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		},
		async execute(_args, exec) {
			const caller = exec?.agent;
			return {
				agents: [...roots.values()].map((state) => ({
					agent: state.agent.id,
					mounted: state.mounted,
					started: state.started,
					completed: state.completed,
					fallbacks: state.fallbacks,
					truncated: state.truncated,
					summarized: state.summarized,
					summarizeFallbacks: state.summarizeFallbacks,
					inspected: state.inspected,
					verified: state.verified,
					repaired: state.repaired,
					unverified: state.unverified,
					thought: state.thought,
					thinkAsks: state.thinkAsks,
					thinkFailed: state.thinkFailed,
					escalated: state.escalated,
					compacted: state.compacted,
					compactionFailures: state.compactionFailures,
					recycled: state.recycled,
					recycleReasons: Object.fromEntries(state.recycleReasons),
					lastError: state.lastError,
					workers: allWorkers(state).map((worker) => ({
						task: worker.task,
						slot: worker.slot,
						childId: worker.childId ?? null,
						jobs: worker.jobs,
						lastJobAt: worker.lastJobAt,
						contextTokens: worker.contextTokens,
						maxContextTokens: contextLimitOf(worker.task),
					})),
				})),
				routes: Object.fromEntries(TASK_KEYS.map((task) => [task, routeFor(task)])),
				settings: (() => {
					try {
						const descriptors = ctx.get('settings')?.describe?.() ?? [];
						return { count: descriptors.length, ours: descriptors.filter((descriptor) => String(descriptor.ns).includes('delegate')).map((descriptor) => descriptor.ns) };
					} catch (error) {
						return String(error?.message ?? error);
					}
				})(),
				subagentProvider: subagentProvider(),
				requestTimeoutMs: timeoutMs(),
				fallbackToDirect: fallbackToDirect(),
				maxResultChars: maxResultChars(),
				verifyWrites: verifyWrites(),
				budgetStrategy: budgetStrategy(),
				inspectEnabled: inspectEnabled(),
				inspectMaxChars: inspectMaxChars(),
				depthBudget: textOf(config?.depthBudget) || 'normal',
				thinkMaxTurns: thinkMaxTurns(),
				thinkEscalateAfter: thinkEscalateAfter(),
				// Which of this plugin's global tools the calling agent can actually
				// see right now. A model cannot read its own tool schema list, so
				// "the tool is missing" must be answerable from the runtime instead
				// of guessed: ask the registry the same way an executor would.
				tools: toolVisibility(caller),
			};
		},
	});

	ctx.on('agent/created', ({ agent }) => track(agent));
	for (const agent of ctx.agents.list()) track(agent);

	ctx.effect(
		() => () => {
			for (const state of roots.values()) {
				try {
					recycleAll(state);
				} catch {
					// The agent may already be gone.
				}
				for (const dispose of state.disposers) {
					try {
						dispose();
					} catch {
						// The agent may already be gone.
					}
				}
				state.disposers.length = 0;
			}
			roots.clear();
			workersByChild.clear();
		},
		'delegate-io: release all agents',
	);
}
