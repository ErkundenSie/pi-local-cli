import { callerToolOf, isCatalogSearch } from '../tool-bridge.mjs';
import { boundedText, clientInfo, completionUsage, isTokenCount, maxTurnMs, SessionConnection } from './common.mjs';

const safeMode = /^(default|ask|always[-_ ]?ask|on[-_ ]?request|plan|read[-_ ]?only)$/i;

function acpUsage(reported, agent) {
  if (!reported) return undefined;
  let { inputTokens: input, outputTokens: output } = reported;
  if (!isTokenCount(input) || !isTokenCount(output)) return undefined;
  const { totalTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens } = reported;
  const cache = (isTokenCount(cachedReadTokens) ? cachedReadTokens : 0) +
    (isTokenCount(cachedWriteTokens) ? cachedWriteTokens : 0);
  // Claude and Antigravity can report uncached input. Only fold that count in
  // when the total confirms it.
  if ((agent === 'claude' || agent === 'antigravity') && totalTokens === input + output + cache) input += cache;
  if (isTokenCount(totalTokens) && totalTokens !== input + output) return undefined;
  return completionUsage(input, output, cachedReadTokens, thoughtTokens, cachedWriteTokens);
}

export class AcpSession extends SessionConnection {
  #model;
  #modelConfig;
  #availableModels = [];
  #mcp;
  #clientTools;
  #tools;
  #acpContext;
  #imageCapability = false;
  #resumeCapability = false;
  #agyPromptActive = false;
  #agyCompleted = false;
  #effort;
  #effortConfig;
  // Distinguishes cancellation before any text from a partially streamed reply.
  #turnChars = 0;

  constructor(agent, launch, emit, { gateway = false, model, mcpServers = [], clientTools = false, tools = [] } = {}) {
    super(agent, launch, emit, gateway);
    this.#model = model;
    this.#mcp = mcpServers;
    this.#clientTools = clientTools;
    this.#tools = tools;
    this.bind({
      notify: (method, params) => this.#notify(method, params),
      handleRequest: (method, params) => this.#handleRequest(method, params),
    });
  }

  get canCheckpoint() { return this.agent === 'antigravity' && this.#resumeCapability && this.#agyCompleted; }

  async start({ resumeId } = {}) {
    const protocol = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo,
      clientCapabilities: {},
    });
    if (protocol?.protocolVersion !== 1) throw new Error('This CLI did not negotiate ACP version 1.');
    const capabilities = protocol.agentCapabilities;
    const image = (capabilities?.promptCapabilities ?? capabilities?.prompt_capabilities ?? protocol.promptCapabilities)?.image;
    this.#imageCapability = image === true || image?.supported === true;
    this.#resumeCapability = this.gateway && this.agent === 'antigravity' &&
      Boolean((capabilities?.sessionCapabilities ?? capabilities?.session_capabilities)?.resume);
    if (resumeId && !this.#resumeCapability) throw new Error('This CLI does not support native session recovery.');
    // ACP carries a stdio server's environment as {name, value} entries.
    const parameters = {
      cwd: this.cwd,
      mcpServers: this.#mcp.map(({ name, command, args, env }) => ({
        name, command, args,
        env: Object.entries(env ?? {}).map(([key, value]) => ({ name: key, value })),
      })),
    };
    if (this.gateway && this.agent === 'claude') {
      parameters._meta = { claudeCode: { options: {
        // `tools: []` drops the built-ins; `disallowedTools: ['*']` would also
        // drop the caller's MCP tools, so it is only used without them.
        tools: [], ...(this.#clientTools ? {} : { disallowedTools: ['*'] }),
        settingSources: [], ...(this.#clientTools ? {} : { extraArgs: { 'strict-mcp-config': null } }),
        settings: { disableAllHooks: true },
      } } };
    }
    const response = resumeId
      ? await this.rpc.request('session/resume', { ...parameters, sessionId: resumeId }, 15000)
      : await this.rpc.request('session/new', parameters);
    if (resumeId && (!response || typeof response !== 'object' || Array.isArray(response) ||
        (response.sessionId !== undefined && response.sessionId !== resumeId))) {
      throw new Error('Antigravity did not confirm the resumed session.');
    }
    this.sessionId = resumeId ?? response?.sessionId;
    if (this.sessionId) {
      await this.#setSafeMode(response);
      const configs = Array.isArray(response.configOptions) ? response.configOptions : [];
      this.#modelConfig = configs.find((option) => option.category === 'model');
      this.#readEffortConfig(configs);
      const choices = this.#modelConfig?.options?.flatMap((item) => item.options ?? [item]);
      this.#availableModels = choices?.map(({ value, name }) => ({ id: value, name })) ??
        response.models?.availableModels?.map(({ modelId, name }) => ({ id: modelId, name })) ?? [];
      if (this.#model) {
        // CLI's listing may spell an effort as a suffix while ACP offers
        // that family as a base model plus a separate thinking option.
        const tier = this.agent === 'antigravity' && /^((?:gemini|claude)-.+)-(low|medium|high)$/.exec(this.#model);
        const offered = new Set(this.#availableModels.map(row => row.id));
        if (tier && !offered.has(this.#model) && offered.has(tier[1])) {
          this.#model = tier[1];
          await this.#setModel(response);
          await this.setEffort(tier[2], true);
        } else {
          await this.#setModel(response);
        }
      }
    }
    this.emitStarted();
  }

  async #setSafeMode(response) {
    const config = response.configOptions?.find((option) => option.category === 'mode');
    const current = config?.currentValue ?? response.modes?.currentModeId;
    const available = config?.options?.flatMap((item) => item.options ?? [item]);
    const choices = available?.map((option) => option.value) ?? response.modes?.availableModes?.map((mode) => mode.id) ?? [];
    const restrained = this.gateway && !this.#clientTools && choices.find((id) => /^(plan|read[-_ ]?only)$/i.test(id));
    if ((!current || safeMode.test(current)) && (!restrained || current === restrained)) return;
    const preferred = restrained || (choices.find((id) => /^(default|ask|always[-_ ]?ask|on[-_ ]?request)$/i.test(id)) ?? choices.find((id) => safeMode.test(id)));
    if (!preferred) throw new Error('The CLI did not offer an approval mode supported by this plugin. Set its default mode to ask for approval.');
    if (config) {
      await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: config.id, value: preferred });
    } else {
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: preferred });
    }
  }

  #readEffortConfig(configs) {
    this.#effortConfig = configs.find((option) => option.category === 'thought_level') ??
      configs.find((option) => /effort|reasoning|thought/i.test(`${option.id} ${option.category ?? ''}`));
  }

  async catalogModels() {
    const models = this.#availableModels;
    if (this.agent !== 'antigravity') return models;
    const current = this.#modelConfig?.currentValue;
    const options = this.#effortConfig?.options?.flatMap(option => option.options ?? [option]);
    const efforts = options?.map(({ value }) => value);
    return models.map(model => model.id === current ? { ...model, efforts } : model);
  }

  async listModels() { return this.#availableModels; }

  // Unavailable reasoning levels leave the CLI default unless strict.
  async setEffort(effort, strict = false) {
    if (effort === this.#effort) return;
    const previous = this.#effort;
    this.#effort = effort;
    if (effort === undefined) return;
    const config = this.#effortConfig;
    const offered = config?.options?.flatMap((option) => option.options ?? [option]).map((option) => option.value);
    if (!offered?.includes(effort)) {
      this.#effort = previous;
      if (strict) throw new Error('ACP does not offer the requested Antigravity thinking level.');
      return;
    }
    try {
      const result = await this.rpc.request('session/set_config_option', {
        sessionId: this.sessionId, configId: config.id, value: effort,
      });
      const selected = result?.configOptions?.find((option) => option.id === config.id)?.currentValue;
      if (selected !== effort) throw new Error('ACP did not confirm the requested thinking level.');
    } catch (error) {
      this.#effort = previous;
      if (strict) throw error;
    }
  }

  // ACP switches models through a session configuration option.
  async setModel(model) {
    if (model === this.#model) return;
    const previous = this.#model;
    this.#model = model;
    // Without a model the CLI keeps whatever it already uses.
    if (model === undefined) return;
    try {
      await this.#setModel({});
    } catch (error) {
      this.#model = previous;
      throw error;
    }
  }

  async #setModel(response) {
    const config = this.#modelConfig;
    if ((config?.currentValue ?? response.models?.currentModelId) === this.#model) return;
    if (!this.#availableModels.some(({ id }) => id === this.#model)) {
      throw new Error(`The native CLI does not offer ${this.#model} for its current login.`);
    }
    if (config) {
      const result = await this.rpc.request('session/set_config_option', {
        sessionId: this.sessionId, configId: config.id, value: this.#model,
      });
      const selected = result?.configOptions?.find((option) => option.id === config.id)?.currentValue;
      if (selected !== this.#model) throw new Error('The native CLI did not confirm the requested model.');
      this.#modelConfig = { ...config, currentValue: selected };
      if (this.agent === 'antigravity') {
        this.#readEffortConfig(result.configOptions);
        this.#effort = undefined;
      }
    } else {
      await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: this.#model });
    }
  }

  async prompt(text, images = [], { managedTimeout = false } = {}) {
    if (images.length && !this.#imageCapability) {
      throw Object.assign(new Error('This CLI does not accept image input over ACP.'), { status: 400 });
    }
    const prompt = [{ type: 'text', text }];
    for (const image of images) prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data });
    const send = async (content) => {
      this.#turnChars = 0;
      this.#acpContext = undefined;
      this.#agyPromptActive = true;
      try {
        return await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: content }, managedTimeout ? null : maxTurnMs);
      } catch (error) {
        // A cancelled ACP turn can report partial usage and leave the process alive.
        if (error.message !== 'The CLI turn was cancelled.' || this.rpc.closed) throw error;
        return { stopReason: 'cancelled' };
      } finally {
        this.#agyPromptActive = false;
      }
    };
    this.#agyCompleted = false;
    let result = await send(prompt);
    // A CLI with no tools still lets the model reach for one — writing a
    // file, running a command — and then aborts the whole turn. Ask again,
    // saying plainly that only text is wanted, instead of returning silence.
    if (result?.stopReason === 'cancelled' && this.#turnChars === 0 && !this.#clientTools) {
      result = await send([{ type: 'text', text: `${text}\n\nDo not call any tool, write any file or run any command. Reply with text only.` }, ...prompt.slice(1)]);
    }
    this.#agyCompleted = this.#resumeCapability && ['completed', 'end_turn', 'stop'].includes(result?.stopReason);
    // A prompt's own response may carry the plan windows too.
    const limit = result?._meta?.['_claude/rateLimit'];
    if (limit) this.emit({ type: 'claude_limit', limit });
    const grokUsage = this.agent === 'grok' ? result?._meta?.usage : undefined;
    const usage = acpUsage(result?.usage, this.agent) ?? (grokUsage && acpUsage({
      ...grokUsage, thoughtTokens: grokUsage.reasoningTokens, cachedWriteTokens: grokUsage.cacheCreationTokens,
    }, this.agent));
    this.emit({ type: 'usage', usage, turnUsage: usage, context: this.#acpContext,
      usageSource: usage ? 'acp-turn' : undefined });
    return result?.stopReason ?? 'end_turn';
  }

  cancel() {
    this.clearApprovals();
    if (!this.sessionId) return this.close();
    return this.rpc.notify('session/cancel', { sessionId: this.sessionId });
  }

  async retireAgySession() {
    try {
      if (!this.closed && this.canCheckpoint && this.sessionId) {
        await this.rpc.request('session/close', { sessionId: this.sessionId }, 2000);
      }
    } finally {
      this.close();
      // Windows keeps the launch directory locked until the process has exited.
      await Promise.race([this.rpc.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  }

  async #handleRequest(method, params) {
    if (method !== 'session/request_permission') return undefined;
    if (!this.sessionId || params.sessionId !== this.sessionId) return { outcome: { outcome: 'cancelled' } };
    if (this.gateway) {
      if (this.agent === 'antigravity' && !this.#agyPromptActive) return { outcome: { outcome: 'cancelled' } };
      // Only the caller's own tools are approved; the CLI's built-ins, any
      // global MCP server and anything else is refused for this turn.
      // search_tool only lists the caller's catalog. use_tool is approved
      // when its arguments name one of those tools; anything else is refused.
      const allowed = this.#clientTools
        ? (callerToolOf(params.toolCall, this.#tools, { antigravity: this.agent === 'antigravity' }) ||
          (this.agent === 'grok' && isCatalogSearch(params.toolCall)))
        : null;
      const allow = allowed && params.options?.find((option) => option.kind === 'allow_once');
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      const reject = params.options?.find((option) => option.kind === 'reject_once');
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
    }
    const options = (params.options ?? []).filter((option) => ['allow_once', 'reject_once'].includes(option.kind))
      .map((option) => ({ id: option.optionId, label: boundedText(option.name, 100), kind: option.kind }));
    const title = boundedText(params.toolCall?.title) || 'Approve tool call?';
    const input = params.toolCall?.rawInput;
    const detail = boundedText(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2));
    const optionId = await this.ask(title, detail, options);
    return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
  }

  #notify(method, params) {
    if (method !== 'session/update' || params.sessionId !== this.sessionId) return;
    if (this.gateway && this.agent === 'antigravity' && !this.#agyPromptActive) return;
    const update = params.update;
    if (!update) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') {
          if (update.sessionUpdate === 'agent_message_chunk') this.#turnChars += update.content.text.length;
          this.emit({ type: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', text: update.content.text });
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.emit({ type: 'tool', id: update.toolCallId, title: boundedText(update.title), status: update.status });
        break;
      case 'usage_update': {
        if (isTokenCount(update.used) && Number.isSafeInteger(update.size) && update.size > 0) {
          this.#acpContext = { used: update.used, size: update.size };
        }
        // Claude's adapter reports plan windows beside the context usage.
        const limit = update._meta?.['_claude/rateLimit'];
        if (limit) this.emit({ type: 'claude_limit', limit });
        break;
      }
    }
  }
}
