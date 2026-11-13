// Offline check of the settlement-notice filter in the pre-step hook. Not part
// of the shipped bundle: the loop contract is exercised against plain objects.
//
// Regression: a batch made only of worker settlement notices used to be
// rejected, which closed the whole turn as `blocked` before any model request
// and left the chat with no answer.
import assert from 'node:assert/strict';
import { filterPreStep, withoutWorkerNotices } from '../index.js';

const notice = (childId) => ({
	id: `notice-${childId}`,
	role: 'user',
	source: { kind: 'agent-message' },
	content: [{ type: 'text', text: `Background subagent ${childId} finished and will do no more work.` }],
});
const prompt = { id: 'prompt-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the file.' }] };

const readNotice = notice('child-read');
const writeNotice = notice('child-write');
const slotTwoNotice = notice('child-read-2');
const foreignNotice = notice('child-foreign');
// `state.workers` is `task -> pool`, not `task -> worker`: since the pool was
// introduced, iterating the map directly would walk pool objects and leave the
// notices of slots 1 and 2 unfiltered.
const state = {
	workers: new Map([
		['read', { task: 'read', workers: [{ task: 'read', slot: 0, childId: 'child-read' }, { task: 'read', slot: 1, childId: 'child-read-2' }, { task: 'read', slot: 2, childId: undefined }] }],
		['write', { task: 'write', workers: [{ task: 'write', slot: 0, childId: 'child-write' }] }],
	]),
};

// 1. Only this root's worker notices are dropped; other messages survive.
assert.deepEqual(withoutWorkerNotices(state, [readNotice, prompt, writeNotice]), [prompt]);
assert.deepEqual(withoutWorkerNotices(state, [readNotice]), [], 'a notice-only batch is empty, never rejected');

// 2. A notice from an unrelated child is left alone.
assert.deepEqual(withoutWorkerNotices(state, [foreignNotice]), [foreignNotice]);

// 2a. A notice from a pool slot other than 0 is dropped too: the filter
//     resolves every member of every pool, not just the head worker.
assert.deepEqual(withoutWorkerNotices(state, [slotTwoNotice, prompt]), [prompt]);

// 3. No tracked workers means nothing is filtered.
assert.deepEqual(withoutWorkerNotices({ workers: new Map() }, [prompt, readNotice]), [prompt, readNotice]);
assert.deepEqual(withoutWorkerNotices(undefined, [prompt]), [prompt]);

// 4. The pre-step filter keeps a notice-only batch as an `enter` decision with
// no messages: the loop continues the running turn and the model answers.
const decision = { kind: 'enter', messages: [readNotice], startsRequestSeries: true };
const filtered = filterPreStep(state, decision);
assert.equal(filtered.kind, 'enter', 'never rejects the step');
assert.deepEqual(filtered.messages, []);
assert.equal(filtered.startsRequestSeries, true, 'the rest of the decision is preserved');

// 5. Mixed batches keep the non-notice messages.
assert.deepEqual(filterPreStep(state, { kind: 'enter', messages: [readNotice, prompt] }).messages, [prompt]);

// 6. A batch without notices passes through untouched, by identity.
const untouched = { kind: 'enter', messages: [prompt] };
assert.equal(filterPreStep(state, untouched), untouched);

// 7. Other decisions and unknown roots pass through untouched.
const rejected = { kind: 'reject' };
assert.equal(filterPreStep(state, rejected), rejected);
assert.equal(filterPreStep(undefined, decision), decision);
assert.equal(filterPreStep(state, null), null);

console.log('delegate-io: all offline checks passed');
