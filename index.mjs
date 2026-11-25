import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { createBridgeServer } from './lib/bridge-server.mjs';
import { catalogModels, restoreCatalog } from './lib/catalog.mjs';
import { codexContextWindows } from './lib/codex-metadata.mjs';
import { readCliQuotas } from './lib/cli-quota.mjs';
import { listAgents } from './lib/launch.mjs';
import { catalogContextWindows, grokContextWindows } from './lib/model-context.mjs';
import { formatDiagnostics, formatUsage } from './lib/usage-display.mjs';
import { baseURL, createBackend, providerId } from './lib/provider.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const adapter = openAICompletionsApi();
const marker = 'pi-local-cli-in-process';
const compat = {
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsStrictMode: false,
  supportsReasoningEffort: true,
  maxTokensField: 'max_tokens',
};

function piModel({ id, name, agent, efforts }, contextWindow) {
  const thinkingLevelMap = efforts?.length
    ? Object.fromEntries(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .map((level) => [level, efforts.includes(level) ? level : null]))
    : { max: agent === 'antigravity' ? 'max' : null };
  return {
    type: 'chat', id, name, provider: providerId, api: 'openai-completions',
    baseUrl: baseURL, compat, reasoning: true, thinkingLevelMap,
    input: ['text', 'image'],
    contextWindow,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function toPiModels(rows) {
  const windows = {
    codex: rows.some(({ agent }) => agent === 'codex') ? codexContextWindows() : undefined,
    grok: rows.some(({ agent }) => agent === 'grok') ? grokContextWindows() : undefined,
    claudeOneMillionDisabled: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1',
  };
  const contextWindows = catalogContextWindows(rows, windows);
  return rows.map((row, i) => piModel(row, contextWindows[i]));
}

export default function (pi) {
  const mcp = createBridgeServer();
  let sessionContext;
  const backend = createBackend(root, {
    bridge: mcp.bridge, startBridge: mcp.start,
    checkpointDir: process.env.PI_LOCAL_CLI_AGY_RESUME === '0'
      ? undefined : join(getAgentDir(), 'local-cli', 'agy-checkpoints'),
    onProgress(caller, { phase, detail }) {
      const ctx = sessionContext;
      if (!ctx?.hasUI || ctx.sessionManager.getSessionId() !== caller) return;
      if (phase === 'lost' || phase === 'error' || phase === 'cancelled') {
        ctx.ui.notify(`Local CLI: ${detail}`, phase === 'lost' ? 'warning' : 'error');
      }
    },
  });
  let discovered = [];
  let currentCatalog = {};
  const installed = () => listAgents(root).filter(({ available }) => available);
  const getModels = () => {
    const defaults = installed().map(({ id, label }) =>
      ({ id: `${id}-default`, agent: id, name: `${label} (CLI default)` }));
    const allowed = new Set(defaults.map(({ agent }) => agent));
    return toPiModels([...defaults, ...discovered.filter(({ agent }) => allowed.has(agent))]);
  };

  function optionsFor(model, options) {
    return {
      ...options, apiKey: marker, maxRetries: 0, cacheRetention: 'none',
      fetch: (input, init) => backend.fetch(input, init, {
        expectedModel: model.id,
        caller: options?.sessionId ?? '',
        disableContinuation: options?.disableContinuation === true,
        cancelSignal: options?.signal,
      }),
    };
  }

  pi.registerProvider({
    id: providerId, name: 'Local CLI', baseUrl: baseURL, getModels,
    auth: { apiKey: {
      name: 'Signed in through the local CLI',
      // Pi Web's settings list only includes providers with a setup method.
      // This is a local marker, not a vendor credential; no input is needed.
      async login({ signal } = {}) {
        signal?.throwIfAborted();
        if (!installed().length) throw new Error('No supported local AI CLI was found. Run /local-cli for details.');
        return { type: 'api_key', key: marker };
      },
      async resolve() {
        return installed().length ? { auth: { apiKey: marker }, source: 'Local CLI' } : undefined;
      },
    } },
    refreshModelsAuth: 'configured',
    async refreshModels(context) {
      const stored = restoreCatalog(context.stored);
      const { next, changed } = context.allowNetwork
        ? await backend.refreshCatalog(stored, context.signal, context.force)
        : { next: stored, changed: false };
      const models = catalogModels(next);
      await context.publish({
        ...(changed && { persist: {
          checkedAt: Date.now(), models: toPiModels(models), piLocalCliCatalog: next,
        } }),
        update: () => {
          backend.setCatalog(next);
          currentCatalog = next;
          discovered = models;
        },
      });
    },
    stream(model, context, options) {
      return adapter.stream({ ...model, api: 'openai-completions', baseUrl: baseURL, compat }, context, optionsFor(model, options));
    },
    streamSimple(model, context, options) {
      return adapter.streamSimple({ ...model, api: 'openai-completions', baseUrl: baseURL, compat }, context, optionsFor(model, options));
    },
  });

  pi.registerCommand('local-cli', {
    description: 'Local CLI: status, doctor [probe], or usage',
    async handler(args, ctx) {
      const action = args.trim();
      if (action === 'status') {
        const status = backend.turnStatus(ctx.sessionManager.getSessionId());
        ctx.ui.notify(status ? `Local CLI · ${status.model}\n${status.detail}` : 'No Local CLI turn in this session yet.', 'info');
        return;
      }
      if (action === 'usage') {
        const stats = backend.lastUsage(ctx.sessionManager.getSessionId());
        const piModel = ctx.model?.provider === providerId ? ctx.model : undefined;
        const estimate = stats && piModel?.id === stats.model ? ctx.getContextUsage() : undefined;
        const present = installed();
        ctx.ui.notify('Checking CLI quota…', 'info');
        const signal = AbortSignal.timeout(12000);
        const quotas = await readCliQuotas(root, present.map(({ id }) => id), signal);
        const reported = quotas.some((line) => line && !/quota: not (?:reported|available)/.test(line));
        const text = formatUsage(stats, estimate, { piModel, omitQuotaNote: reported });
        ctx.ui.notify([text, ...quotas].filter(Boolean).join('\n'), 'info');
        return;
      }
      if (action && action !== 'doctor' && action !== 'doctor probe') {
        ctx.ui.notify('Usage: /local-cli [status | doctor [probe] | usage]', 'warning');
        return;
      }
      const probe = action === 'doctor probe';
      let snapshot = currentCatalog;
      if (probe) {
        ctx.ui.notify('Checking CLI model catalogs (no inference)…', 'info');
        try {
          snapshot = (await backend.refreshCatalog(currentCatalog, AbortSignal.timeout(14500), true)).next;
        } catch {
          ctx.ui.notify('Catalog probe did not finish. Showing the cached directory.', 'warning');
        }
      }
      const lines = listAgents(root).map(({ id, label, available, hint }) => {
        if (!available) return `${label}: not found — ${hint}`;
        if (!action) return `${label}: found (sign-in not checked)`;
        const entry = snapshot[id];
        const attempt = backend.catalogAttempt(id);
        const result = entry
          ? `${entry.models.length} models · ${entry.source ?? 'cached'} · ${new Date(entry.checkedAt).toLocaleString()}`
          : 'no catalog — use Refresh Model Catalog or /local-cli doctor probe';
        return `${label}: ${result}${attempt?.note ? ` (last check: ${attempt.note})` : ''}`;
      });
      if (action) lines.push(formatDiagnostics({
        resumeEnabled: process.env.PI_LOCAL_CLI_AGY_RESUME !== '0',
        bridge: mcp.status(),
        status: backend.turnStatus(ctx.sessionManager.getSessionId()),
      }));
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.on('session_start', (_event, ctx) => { sessionContext = ctx; });
  pi.on('session_shutdown', async () => {
    sessionContext = undefined;
    await Promise.all([backend.stop(), mcp.stop()]);
  });
}
