const tokens = (n) => n.toLocaleString();

export function formatUsage(stats, estimate) {
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
  return lines.join('\n');
}
