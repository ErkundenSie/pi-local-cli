const tokens = (n) => n.toLocaleString();
const quotaWindows = { five_hour: '5h', seven_day: '7d', seven_day_overage_included: '7d included' };

export function quotaFromClaude(limit) {
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return undefined;
  const status = ['allowed', 'allowed_warning', 'rejected'].includes(limit.status) ? limit.status : undefined;
  const windows = [];
  const source = limit.unifiedWindows;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [name, window] of Object.entries(source)) {
      const label = quotaWindows[name];
      const utilization = Number(window?.utilization);
      const resetsAt = Number(window?.resetsAt);
      if (!label || !Number.isFinite(utilization) || utilization < 0 || utilization > 100) continue;
      if (!Number.isSafeInteger(resetsAt) || resetsAt <= 0) continue;
      windows.push({ label, utilization, resetsAt: resetsAt < 1e12 ? resetsAt * 1000 : resetsAt });
    }
  }
  return status || windows.length ? { status, windows } : undefined;
}

export function formatDiagnostics({ resumeEnabled, bridge, status }) {
  const lines = [
    `Antigravity resume: ${resumeEnabled ? 'enabled' : 'disabled'}`,
    `Tool bridge: ${bridge.listening ? 'listening' : 'not started'} · ${bridge.sessions} session(s) · ${bridge.pending} pending call(s)`,
  ];
  if (status) lines.push(`Last turn: ${status.phase} — ${status.detail}`);
  return lines.join('\n');
}

export function formatUsage(stats, estimate, options = {}) {
  const { piModel, omitQuotaNote } = options;
  if (!stats && !piModel) return 'No Local CLI usage captured for this session yet.';
  const lines = [stats
    ? `Local CLI · ${stats.model} · ${new Date(stats.at).toLocaleTimeString()}`
    : 'Local CLI · No usage captured for this session yet'];
  const budget = piModel?.contextWindow ?? estimate?.contextWindow;
  if (budget > 0) {
    const label = piModel && piModel.id !== stats?.model ? ` (${piModel.id})` : '';
    lines.push(`Pi context budget${label}: ${tokens(budget)} tokens`);
  }
  const size = stats?.context?.size;
  const used = stats?.context?.used;
  if (size > 0 && used != null) {
    lines.push(`CLI context (reported): ${tokens(used)} / ${tokens(size)} tokens`);
  } else if (size > 0) {
    lines.push(`CLI context window (reported): ${tokens(size)} tokens · occupancy not reported`);
  } else {
    lines.push('CLI context: not reported');
  }
  if (!stats) return lines.join('\n');
  if (stats.usageSource === 'codex-last' && stats.usage?.total_tokens != null) {
    lines.push(`Last inference usage (CLI, not context occupancy): ${tokens(stats.usage.total_tokens)} tokens`);
  } else if (used == null && estimate?.tokens != null) {
    lines.push(`Pi context estimate (may include repeated inputs): ${tokens(estimate.tokens)} tokens`);
  }
  if (stats.turnUsage) {
    const u = stats.turnUsage;
    lines.push(`CLI turn total: ${tokens(u.total_tokens)} tokens (input ${tokens(u.prompt_tokens)}, output ${tokens(u.completion_tokens)})`);
  } else {
    lines.push('CLI turn total: not reported');
  }
  if (stats.quota?.status) lines.push(`Claude plan: ${stats.quota.status}`);
  for (const window of stats.quota?.windows ?? []) {
    lines.push(`Claude ${window.label}: ${window.utilization}% used, resets ${new Date(window.resetsAt).toLocaleString()}`);
  }
  if (!stats.quota && !omitQuotaNote) lines.push('Quota: not reported by the CLI');
  return lines.join('\n');
}

function shortLabel(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 48 || /[\u0000-\u001f]/.test(text)) return undefined;
  return text;
}

function resetLabel(value, now) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return undefined;
  const time = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return reset.toDateString() === now.toDateString() ? time : `${time} ${reset.toLocaleDateString()}`;
}

export function parseAgyQuota(text, now = new Date()) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  const result = root?.event === 'result' && root.result && typeof root.result === 'object' && !Array.isArray(root.result)
    ? root.result : root;
  const command = result?.command && typeof result.command === 'object' && !Array.isArray(result.command) ? result.command : undefined;
  if (command?.name && command.name !== 'usage') return undefined;
  const data = command?.data && typeof command.data === 'object' && !Array.isArray(command.data) ? command.data : result?.data;
  if (!data || !Array.isArray(data.groups)) return undefined;
  const lines = [];
  for (const group of data.groups.slice(0, 6)) {
    const name = shortLabel(group?.name);
    if (!name || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets.slice(0, 4)) {
      const window = shortLabel(bucket?.window) ?? shortLabel(bucket?.name);
      const fraction = Number(bucket?.remaining_fraction ?? bucket?.remainingFraction);
      if (!window || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const reset = resetLabel(bucket.reset_time ?? bucket.resetTime, now);
      lines.push(`Antigravity ${name} · ${window}: ${Math.round(fraction * 100)}% left${reset ? `, resets ${reset}` : ''}`);
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

function resetFromUnix(value, now) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return resetLabel(new Date(number < 1e12 ? number * 1000 : number).toISOString(), now);
}

function windowFromMinutes(minutes) {
  if (minutes >= 280 && minutes <= 320) return '5h';
  if (minutes >= 9800 && minutes <= 10200) return '7d';
  if (minutes >= 40000 && minutes <= 46000) return '30d';
  return undefined;
}

function quotaLine(name, window, remaining, reset) {
  if (!shortLabel(name) || !shortLabel(window) || !Number.isInteger(remaining) || remaining < 0 || remaining > 100) return undefined;
  return `${name} ${window}: ${remaining}% left${reset ? `, resets ${reset}` : ''}`;
}

export function parseCodexQuota(payload, now = new Date()) {
  const limits = payload?.rateLimits;
  if (!limits || typeof limits !== 'object') return undefined;
  const lines = [];
  for (const key of ['primary', 'secondary']) {
    const window = limits[key];
    const label = windowFromMinutes(Number(window?.windowDurationMins));
    const used = Number(window?.usedPercent);
    if (!label || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const line = quotaLine('Codex', label, Math.round(100 - used), resetFromUnix(window.resetsAt, now));
    if (line) lines.push(line);
  }
  return lines.length ? lines.join('\n') : undefined;
}

export function parseClaudeQuota(text, now = new Date()) {
  if (typeof text !== 'string' || /not logged in|run \/login/i.test(text)) return undefined;
  const lines = [];
  const pattern = /(5[\s-]*hour|7[\s-]*day|weekly)[^\n%\d]{0,48}(\d{1,3}(?:\.\d+)?)%\s*(used|left)/gi;
  for (const match of text.matchAll(pattern)) {
    const label = /5/i.test(match[1]) ? '5h' : '7d';
    const value = Math.round(Number(match[2]));
    const remaining = /left/i.test(match[3]) ? value : 100 - value;
    const line = quotaLine('Claude', label, remaining, undefined);
    if (line && !lines.includes(line)) lines.push(line);
  }
  const reset = resetLabel(text.match(/resets?\s+(\d{4}-\d{2}-\d{2}T[^\s,]+)/i)?.[1], now);
  return lines.length ? lines.map((line, index) => index === 0 && reset ? `${line}, resets ${reset}` : line).join('\n') : undefined;
}

export function parseGrokQuota(text, now = new Date()) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const usage = parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : parsed;
  const remaining = Number(usage?.remainingPercent ?? usage?.remaining_percent);
  const used = Number(usage?.usedPercent ?? usage?.used_percent);
  const percent = Number.isFinite(remaining) && remaining >= 0 && remaining <= 100 ? Math.round(remaining)
    : Number.isFinite(used) && used >= 0 && used <= 100 ? Math.round(100 - used) : undefined;
  const window = /week/i.test(String(usage?.type ?? '')) ? 'weekly' : /month/i.test(String(usage?.type ?? '')) ? 'monthly' : undefined;
  const reset = resetLabel(usage?.resetAt ?? usage?.reset_at, now);
  const line = percent === undefined ? undefined : quotaLine('Grok', window ?? 'plan', percent, reset);
  return line;
}

export function parseGrokBilling(payload, now = new Date()) {
  const config = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config) ? payload.config : payload;
  const period = config?.currentPeriod && typeof config.currentPeriod === 'object' ? config.currentPeriod : {};
  const type = String(period.type ?? '');
  const window = /week/i.test(type) ? 'weekly' : /month/i.test(type) ? 'monthly' : 'plan';
  const reset = resetLabel(period.end, now) ?? resetLabel(config?.billingPeriodEnd, now);
  const raw = config?.creditUsagePercent;
  let used = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : undefined;
  // Grok's billing response omits a zero-valued proto3 scalar. Only infer zero
  // when the response also identifies an actual subscription period and reset.
  if (raw === undefined && /^USAGE_PERIOD_TYPE_(WEEKLY|MONTHLY)$/.test(type) && reset) used = 0;
  if (!Number.isFinite(used) || used < 0 || used > 100) return undefined;
  return quotaLine('Grok', window, Math.round(100 - used), reset);
}

export function parseClaudeOAuthUsage(payload, now = new Date()) {
  const lines = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const window = payload?.[key];
    const used = Number(window?.utilization);
    if (!Number.isFinite(used) || used < 0 || used > 100) continue;
    const line = quotaLine('Claude', label, Math.round(100 - used), resetLabel(window.resets_at, now));
    if (line) lines.push(line);
  }
  return lines.length ? lines.join('\n') : undefined;
}
