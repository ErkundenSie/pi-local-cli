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
  if (!stats) return 'No Local CLI usage captured for this session yet.';
  const lines = [`Local CLI · ${stats.model} · ${new Date(stats.at).toLocaleTimeString()}`];
  const size = stats.context?.size ?? estimate?.contextWindow;
  if (stats.context?.used !== undefined) {
    lines.push(`Context (reported by CLI): ${tokens(stats.context.used)} / ${tokens(size)} tokens`);
  } else if (stats.usageSource === 'codex-last') {
    const used = stats.usage.total_tokens;
    lines.push(`Context estimate (last inference): ${tokens(used)}${size ? ` / ${tokens(size)}` : ''} tokens`);
  } else if (estimate?.tokens != null) {
    lines.push(`Context estimate (Pi; may include repeated inputs): ${tokens(estimate.tokens)} / ${tokens(estimate.contextWindow)} tokens`);
  } else {
    lines.push('Context occupancy: not reported');
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
  if (!stats.quota && !options.omitQuotaNote) lines.push('Quota: not reported by the CLI');
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
