import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUsage } from '../lib/usage-display.mjs';

test('labels CLI context, last-inference estimates and turn totals separately', () => {
  const stats = { model: 'fixture', at: 0, context: { size: 900 },
    usageSource: 'codex-last', usage: { total_tokens: 120 },
    turnUsage: { total_tokens: 240, prompt_tokens: 200, completion_tokens: 40 } };
  assert.match(formatUsage(stats), /Context estimate \(last inference\): 120 \/ 900 tokens/);
  assert.match(formatUsage(stats), /CLI turn total: 240 tokens/);
  assert.match(formatUsage({ ...stats, context: { size: 900, used: 100 } }), /Context \(reported by CLI\): 100 \/ 900/);
  const unknown = { ...stats, usageSource: undefined };
  assert.match(formatUsage(unknown), /Context occupancy: not reported/);
  assert.match(formatUsage(unknown, { tokens: 80, contextWindow: 900 }), /Context estimate \(Pi;/);
});
