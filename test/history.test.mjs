import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuation, historyFingerprint, matchesHistory, toolConfigFingerprint } from '../lib/history.mjs';

const request = {
  caller: 'session',
  messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: [
    { type: 'text', text: 'Look' }, { type: 'text', text: ' here' },
  ] }],
  images: [{ at: 1, mimeType: 'image/png', data: 'aW1hZ2U=' }],
  tools: [], toolChoice: 'none', parallelToolCalls: true,
};
const reply = { role: 'assistant', content: 'Okay', refusal: null };

// Keep recovery points written by earlier versions readable after refactors.
test('preserves the history and tool configuration fingerprint format', () => {
  assert.equal(historyFingerprint(request, 3, reply), 'de365ac31cd53a8de2101f4c540acaecfa14eb65b161ee9dc2710902f59f45e9');
  assert.equal(toolConfigFingerprint(request), '05ea7f017fd315d259b6204fcd6bbf2aa3bde17e14d03197c5a80c2e48650962');
});

test('only a matching prefix may resume and only new images travel in the suffix', () => {
  const toolConfig = toolConfigFingerprint(request);
  const record = { caller: request.caller, toolConfig, historyLength: 3, historyHash: historyFingerprint(request, 3, reply) };
  const newImage = { at: 3, mimeType: 'image/png', data: 'bmV3' };
  const next = { ...request, messages: [...request.messages, reply, { role: 'user', content: 'Continue' }], images: [...request.images, newImage] };
  assert.equal(matchesHistory(record, toolConfig, next, new Map()), true);
  assert.equal(matchesHistory(record, toolConfig, { ...next, caller: 'another' }, new Map()), false);
  assert.equal(matchesHistory(record, 'changed', next, new Map()), false);
  assert.equal(matchesHistory(record, toolConfig, { ...next, images: [{ ...request.images[0], data: 'ZWRpdA==' }, newImage] }, new Map()), false);

  const suffix = continuation(3, next);
  assert.deepEqual(suffix.images, [newImage]);
  assert.match(suffix.prompt, /Continue/);
  assert.doesNotMatch(suffix.prompt, /Look here|Okay/);
  assert.equal(continuation(3, { ...next, messages: [...next.messages, { role: 'tool', content: 'late' }] }), undefined);
});
