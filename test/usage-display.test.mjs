import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiagnostics, formatUsage, parseAgyQuota, parseClaudeOAuthUsage, parseClaudeQuota, parseCodexQuota, parseGrokBilling, parseGrokQuota, quotaFromClaude } from '../lib/usage-display.mjs';

test('shows the active Pi budget even before usage exists or after switching models', () => {
  const options = { piModel: { id: 'next-model', contextWindow: 900 } };
  const first = formatUsage(undefined, undefined, options);
  assert.match(first, /No usage captured/);
  assert.match(first, /Pi context budget \(next-model\): 900 tokens/);
  assert.match(first, /CLI context: not reported/);
  const switched = formatUsage({ model: 'old-model', at: 0, context: { used: 5, size: 800 } }, undefined, options);
  assert.match(switched, /Local CLI · old-model/);
  assert.match(switched, /Pi context budget \(next-model\): 900 tokens/);
  assert.match(switched, /CLI context \(reported\): 5 \/ 800 tokens/);
});

test('Grok billing omits zero usage only for a recognized period with a reset', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const currentPeriod = { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-12-01T02:48:00Z' };
  const config = { currentPeriod };
  assert.match(parseGrokBilling({ config }, now), /^Grok weekly: 100% left, resets /);
  assert.match(parseGrokBilling({ config: { ...config, creditUsagePercent: 15 } }, now), /^Grok weekly: 85% left/);
  for (const creditUsagePercent of [null, '', 'unknown', -1, 101]) {
    assert.equal(parseGrokBilling({ config: { ...config, creditUsagePercent } }, now), undefined);
  }
  assert.equal(parseGrokBilling({ config: { currentPeriod: { type: currentPeriod.type } } }, now), undefined);
  assert.equal(parseGrokBilling({ config: { currentPeriod: { ...currentPeriod, type: 'UNKNOWN' } } }, now), undefined);
  assert.equal(parseGrokBilling({ config: {} }, now), undefined);
});

test('labels CLI context, last-inference estimates and turn totals separately', () => {
  const stats = { model: 'fixture', at: 0, context: { size: 900 },
    usageSource: 'codex-last', usage: { total_tokens: 120 },
    turnUsage: { total_tokens: 240, prompt_tokens: 200, completion_tokens: 40 } };
  assert.match(formatUsage(stats), /CLI context window \(reported\): 900 tokens · occupancy not reported/);
  assert.match(formatUsage(stats), /Last inference usage \(CLI, not context occupancy\): 120 tokens/);
  assert.match(formatUsage(stats), /CLI turn total: 240 tokens/);
  const reported = formatUsage({ ...stats, context: { size: 1_000_000, used: 0 } }, undefined, {
    piModel: { id: 'fixture', contextWindow: 512_000 },
  });
  assert.ok(reported.includes(`Pi context budget: ${(512_000).toLocaleString()} tokens`));
  assert.ok(reported.includes(`CLI context (reported): 0 / ${(1_000_000).toLocaleString()} tokens`));
  const unknown = { ...stats, context: undefined, usageSource: undefined };
  const estimated = formatUsage(unknown, { tokens: 80, contextWindow: 900 });
  assert.match(estimated, /CLI context: not reported/);
  assert.match(estimated, /Pi context estimate \(may include repeated inputs\): 80 tokens/);
  assert.doesNotMatch(estimated, /CLI context window \(reported\)/);
  assert.match(formatUsage(stats), /Quota: not reported/);
  const quota = quotaFromClaude({ status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 20, resetsAt: 1_800_000_000 }, unknown: { utilization: 1, resetsAt: 1 },
  } });
  assert.equal(quota.windows.length, 1);
  assert.match(formatUsage({ ...stats, quota }), /Claude plan: allowed/);
  assert.match(formatUsage({ ...stats, quota }), /Claude 5h: 20% used/);
  assert.match(formatDiagnostics({
    resumeEnabled: false, bridge: { listening: true, sessions: 1, pending: 0 },
    status: { phase: 'lost', detail: 'bridge disconnected' },
  }), /resume: disabled[\s\S]*listening · 1 session\(s\)[\s\S]*Last turn: lost/);
  const now = new Date('2026-09-04T08:00:00');
  const agy = parseAgyQuota(JSON.stringify({ event: 'result', result: { command: { name: 'usage', data: {
    account: 'private@example.com',
    groups: [{ name: 'Gemini Models', buckets: [
      { window: '5h', remaining_fraction: 0.984, reset_time: '2026-09-04T19:53:00', email: 'private@example.com' },
      { window: 'weekly', remaining_fraction: 1.4, reset_time: '2026-09-11T09:10:00' },
    ] }],
  } } } }), now);
  assert.match(agy, /Gemini Models · 5h: 98% left/);
  assert.doesNotMatch(agy, /private@example.com|weekly/);
  assert.equal(parseAgyQuota(JSON.stringify({ command: { name: 'prompt' } })), undefined);
  const codex = parseCodexQuota({ accountId: 'acct_private', rateLimits: {
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: Date.parse('2026-09-04T19:53:00') / 1000 },
    secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: Date.parse('2026-09-11T09:10:00') / 1000 },
  } }, now);
  assert.match(codex, /Codex 5h: 99% left/);
  assert.match(codex, /Codex 7d: 55% left/);
  assert.doesNotMatch(codex, /acct_private/);
  assert.equal(parseClaudeQuota('Not logged in · Please run /login'), undefined);
  assert.match(parseClaudeQuota('5-hour limit: 12% used\n7-day limit: 40% used'), /Claude 5h: 88% left[\s\S]*Claude 7d: 60% left/);
  assert.match(parseGrokQuota(JSON.stringify({ usage: { type: 'weekly', remainingPercent: 70, resetAt: '2026-09-11T09:10:00' } }), now), /Grok weekly: 70% left/);
  assert.match(parseGrokBilling({ config: { creditUsagePercent: 30, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-11T09:10:00Z' } } }, now), /Grok weekly: 70% left/);
  assert.match(parseClaudeOAuthUsage({ five_hour: { utilization: 12, resets_at: '2026-09-04T19:53:00Z' }, seven_day: { utilization: 40, resets_at: '2026-09-11T09:10:00Z' } }, now), /Claude 5h: 88% left/);
  assert.doesNotMatch(parseClaudeOAuthUsage({ five_hour: { utilization: 12, resets_at: '2026-09-04T19:53:00Z' }, email: 'private@example.com' }, now), /private@example.com/);
});
