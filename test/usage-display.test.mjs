import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiagnostics, formatUsage, parseAgyQuota, parseClaudeOAuthUsage, parseClaudeQuota, parseCodexQuota, parseGrokBilling, parseGrokQuota, quotaFromClaude } from '../lib/usage-display.mjs';

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
