import { boundedText, clientInfo, completionUsage, isTokenCount, maxTurnMs, SessionConnection } from './common.mjs';

function codexUsage(stats) {
  return stats && completionUsage(stats.inputTokens, stats.outputTokens, stats.cachedInputTokens, stats.reasoningOutputTokens);
}

export class CodexSession extends SessionConnection {
  #model;
  #effort;
  #codexTokenTotal;
  #nativeTurn;

  constructor(launch, emit, { gateway = false, model } = {}) {
    super('codex', launch, emit, gateway);
    this.#model = model;
    this.bind({
      notify: (method, params) => this.#notify(method, params),
      handleRequest: (method, params) => this.#handleRequest(method, params),
      onClose: (error) => this.#completeNativeTurn(error),
    });
  }

  async start() {
    await this.rpc.request('initialize', { clientInfo });
    this.rpc.notify('initialized');
    const { config } = await this.rpc.request('config/read', { cwd: this.cwd, includeLayers: false });
    if (!config || config.model_provider !== 'openai' || config.openai_base_url ||
        (config.chatgpt_base_url && config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/')) {
      throw new Error('Codex did not resolve to native OpenAI routing. Check its effective provider settings.');
    }
    if (!this.gateway) {
      void this.rpc.request('account/read', { refreshToken: false }, 1200).then((result) => {
        if (this.closed) return;
        const type = result?.account?.type;
        const status = type === 'chatgpt' || type === 'apiKey' ? 'authorized' :
          result?.account === null && result.requiresOpenaiAuth === true ? 'required' : 'unknown';
        this.emit({ type: 'account_status', agent: this.agent, status });
      }).catch(() => {});
    }
    if (this.gateway) {
      // Every server the CLI would start must be this plugin's own bridge,
      // the empty stand-in that replaces a local server, or a remote server
      // left in config with enabled=false.
      const foreign = Object.entries(config.mcp_servers ?? {}).filter(([, entry]) => {
        if (entry?.enabled === false) return false;
        const args = JSON.stringify(entry?.args ?? []);
        return !/(?:empty-mcp|mcp-stdio)\.mjs/.test(args);
      });
      if (foreign.length) {
        throw new Error(`Codex still has MCP servers that are not isolated: ${foreign.map(([name]) => name).join(', ')}.`);
      }
    }
    // The native route takes a native model id; a host-written catalogue
    // (magpie's model list) names models as `<provider>/<model>`.
    const model = this.#model ?? await this.#nativeModel(config);
    const response = await this.rpc.request('thread/start', {
      cwd: this.cwd, modelProvider: 'openai',
      sandbox: this.gateway ? 'read-only' : 'workspace-write',
      approvalPolicy: 'never',
      ...(this.gateway ? { ephemeral: true } : {}),
      ...(model ? { model } : {}),
    });
    if (model && response?.model !== model) throw new Error('Codex did not select the requested model.');
    this.sessionId = response?.thread?.id;
    if (response?.modelProvider && response.modelProvider !== 'openai') {
      throw new Error('Codex selected a non-OpenAI provider. Use the native OpenAI provider for this session.');
    }
    this.emitStarted();
  }

  catalogModels() { return this.listModels(); }

  async listModels() {
    const { data } = await this.rpc.request('model/list', { modelProvider: 'openai', includeHidden: false, limit: 80 }, 8000);
    const native = new Map();
    for (const entry of data ?? []) {
      if (typeof entry?.model !== 'string') continue;
      // `codex/x` and `openai/x` are the ChatGPT/API models of a host-written
      // catalogue; other namespaces belong to that host, not to this CLI.
      const [namespace, rest] = entry.model.includes('/') ? entry.model.split('/', 2) : [null, entry.model];
      if (namespace && !/^(codex|openai)$/i.test(namespace)) continue;
      if (!/^[a-zA-Z0-9._-]{1,96}$/.test(rest)) continue;
      if (!native.has(rest)) native.set(rest, { id: rest, name: entry.displayName || rest });
    }
    return [...native.values()];
  }

  // #nativeModel is the model a native OpenAI route accepts: the configured
  // one when it is already a plain id, else the first native id the account
  // offers. Nothing when the configuration is usable as it stands.
  async #nativeModel(config) {
    const configured = typeof config?.model === 'string' ? config.model : '';
    if (!configured.includes('/')) return undefined;
    const wanted = configured.slice(configured.indexOf('/') + 1);
    const offered = await this.listModels().catch(() => []);
    return offered.some(({ id }) => id === wanted) ? wanted : offered[0]?.id;
  }

  async setEffort(effort) { this.#effort = effort; }

  async setModel(model) { this.#model = model; }

  async prompt(text, images = [], { managedTimeout = false } = {}) {
    const turn = { cancelRequested: false, tokenBaseline: this.#codexTokenTotal };
    this.#nativeTurn = turn;
    const finished = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
      if (!managedTimeout) turn.timer = setTimeout(() => this.#completeNativeTurn(new Error('The Codex turn timed out.')), maxTurnMs);
    });
    // A turn can complete or the process can exit before turn/start returns.
    finished.catch(() => {});
    try {
      const input = [{ type: 'text', text, text_elements: [] }];
      // Codex accepts images only as inline data URLs, never as remote ones.
      for (const image of images) input.push({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` });
      const response = await this.rpc.request('turn/start', {
        threadId: this.sessionId, input,
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#effort ? { effort: this.#effort } : {}),
      });
      if (this.#nativeTurn === turn) {
        turn.id ??= response?.turn?.id;
        if (!turn.id) throw new Error('Codex did not return a turn ID.');
        if (turn.cancelRequested) void this.#interrupt(turn);
      }
      return await finished;
    } catch (error) {
      if (this.#nativeTurn === turn) this.#completeNativeTurn(error);
      throw error;
    }
  }

  #completeNativeTurn(error, status) {
    const turn = this.#nativeTurn;
    if (!turn) return;
    this.#nativeTurn = undefined;
    clearTimeout(turn.timer);
    if (error) {
      turn.reject(error);
      return;
    }
    const delta = (key) => isTokenCount(turn.tokenTotal?.[key])
      ? turn.tokenTotal[key] - (turn.tokenBaseline?.[key] ?? 0)
      : undefined;
    const turnUsage = completionUsage(delta('inputTokens'), delta('outputTokens'),
      delta('cachedInputTokens'), delta('reasoningOutputTokens'));
    const usage = codexUsage(turn.lastUsage);
    // Pi derives context from assistant usage. Feeding it the thread delta
    // would count the prompt once for every internal inference in this turn.
    this.emit({ type: 'usage', usage, turnUsage, context: turn.context,
      usageSource: usage ? 'codex-last' : undefined });
    turn.resolve(status);
  }

  async #interrupt(turn) {
    if (turn.interrupting || this.#nativeTurn !== turn) return;
    turn.interrupting = true;
    try { await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: turn.id }, 5000); }
    catch { this.close(); }
  }

  cancel() {
    this.clearApprovals();
    if (!this.sessionId) return this.close();
    if (this.#nativeTurn) {
      this.#nativeTurn.cancelRequested = true;
      if (this.#nativeTurn.id) void this.#interrupt(this.#nativeTurn);
    }
  }

  async #handleRequest(method, params) {
    if (method === 'item/permissions/requestApproval') {
      // The native workspace policy already covers ordinary edits. Broader access is declined.
      return { permissions: {}, scope: 'turn' };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return undefined;
    if (this.gateway || !this.#nativeTurn || params.threadId !== this.sessionId) return { decision: 'decline' };
    const command = method === 'item/commandExecution/requestApproval';
    const options = [{ id: 'decline', label: 'Decline', kind: 'reject_once' }];
    if (!params.availableDecisions || params.availableDecisions.includes('accept')) {
      options.unshift({ id: 'accept', label: 'Allow once', kind: 'allow_once' });
    }
    const detail = [params.command, params.reason, params.grantRoot].map((value) => boundedText(value)).filter(Boolean).join('\n');
    const selected = await this.ask(command ? 'Approve Codex command?' : 'Approve Codex file change?', detail, options);
    return { decision: selected ?? 'decline' };
  }

  #notify(method, params) {
    const turn = this.#nativeTurn;
    if (!turn || params.threadId !== this.sessionId || (params.turnId && turn.id && params.turnId !== turn.id)) return;
    switch (method) {
      case 'thread/tokenUsage/updated': {
        // Track one inference separately from the cumulative thread meter.
        const { total, last, modelContextWindow } = params.tokenUsage ?? {};
        turn.lastUsage = last;
        if (Number.isSafeInteger(modelContextWindow) && modelContextWindow > 0) {
          turn.context = { size: modelContextWindow };
        }
        if (isTokenCount(total?.inputTokens) && isTokenCount(total?.outputTokens)) {
          turn.tokenTotal = total;
          this.#codexTokenTotal = total;
        }
        break;
      }
      case 'turn/started':
        turn.id = params.turn?.id;
        if (turn.id && turn.cancelRequested) void this.#interrupt(turn);
        break;
      case 'turn/completed': {
        const status = params.turn?.status ?? 'completed';
        this.#completeNativeTurn(status === 'failed' ? new Error(params.turn?.error?.message || 'Codex reported a failed turn.') : null, status);
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (this.gateway && method === 'item/reasoning/textDelta') break;
        if (typeof params.delta === 'string') this.emit({ type: method === 'item/agentMessage/delta' ? 'text' : 'thought', text: params.delta });
        break;
      case 'item/started':
      case 'item/completed': {
        const item = params.item;
        if (!item) break;
        const labels = { commandExecution: item.command, fileChange: 'File change', mcpToolCall: item.tool, webSearch: item.query };
        if (Object.hasOwn(labels, item.type)) this.emit({ type: 'tool', id: item.id, title: boundedText(labels[item.type]), status: item.status ?? (method === 'item/started' ? 'in_progress' : 'completed') });
        break;
      }
    }
  }
}
