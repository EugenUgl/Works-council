// Guard against the Host rejecting a settings save.
//
// `dsh-settings` accepts a form edit only when the path addresses a live field:
// `isVolatilePath` walks the plugin's Config schema with `schema.dict[key]` and
// checks `meta.volatile` at each step. A field the walk cannot find — or one
// whose `.volatile()` call was forgotten — fails the whole save with
// `Config field "<key>" is not volatile`, even when the edit names a different,
// perfectly valid field.
//
// This script mirrors that walk against the plugin's own Config schema, so a
// schema regression fails here instead of in the running GUI.
import assert from 'node:assert/strict';
import { Config } from '../index.js';

/** The subset of `isVolatilePath` the Host applies to one field path. */
function isVolatilePath(schema, path) {
	if (schema.meta?.volatile) return true;
	const [key, ...rest] = path;
	const child = key === void 0 ? void 0 : schema.dict?.[key];
	return child !== void 0 && isVolatilePath(child, rest);
}

const tasks = ['read', 'web', 'write', 'think'];

/** Every field the settings form can write, in form order. */
const formFields = [
	...tasks.flatMap((task) => [
		`${task}Enabled`,
		`${task}Provider`,
		`${task}Model`,
		`${task}ReasoningEffort`,
		`${task}MaxContextTokens`,
	]),
	'thinkMaxTurns',
	'thinkEscalateAfter',
	'subagentProvider',
	'requestTimeoutMs',
	'maxJobsPerWorker',
	'workerIdleMs',
	'maxResultChars',
	'verifyWrites',
	'inspectEnabled',
	'inspectMaxChars',
	'depthBudget',
	'budgetStrategy',
];

// 1. The schema is an object whose fields the walk can address at all.
assert.equal(Config.type, 'object', 'Config must be an object schema');
assert.ok(Config.dict !== undefined, 'Config must expose its fields through `dict`');
assert.ok(Config.meta?.volatile !== true, 'the root is not volatile; each field opts in');

// 2. Every field the form writes is declared and live: the exact condition the
//    Host checks before it accepts a save.
for (const field of formFields) {
	const node = Config.dict[field];
	assert.ok(node !== undefined, `Config has no field "${field}"; a save that sets it is rejected`);
	assert.equal(node.meta?.volatile, true, `Config field "${field}" lacks .volatile(), so a save that sets it is rejected`);
	assert.equal(isVolatilePath(Config, [field]), true, `the Host walk rejects "${field}"`);
}

// 3. The per-worker context limit fields are ours to keep: numeric, off by
//    default, and live exactly like the neighbouring route fields.
for (const task of tasks) {
	const key = `${task}MaxContextTokens`;
	const node = Config.dict[key];
	assert.ok(node, `missing ${key}`);
	assert.equal(node.type, 'number', `${key} must be numeric for the form`);
	assert.equal(node.meta?.default, 0, `${key} must default to 0`);
	assert.equal(node.meta?.volatile, true, `${key} must be volatile`);
}

// 4. Nothing became accidentally live: an undeclared field is still refused,
//    which is what makes the assertions above meaningful.
assert.equal(isVolatilePath(Config, ['notAField']), false, 'an undeclared field must stay rejected');

// 5. No field is declared twice. A duplicated key silently keeps the last
//    definition, which is how a live field can lose its `.volatile()`.
const declared = Object.keys(Config.dict);
assert.equal(new Set(declared).size, declared.length, 'Config declares a duplicate field');

console.log('delegate-io: settings schema volatility checks passed');
