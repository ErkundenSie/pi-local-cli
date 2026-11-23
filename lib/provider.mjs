import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effortValues, parseChatRequest, serveChat } from './chat-wire.mjs';
import { agyModelFamilies } from './catalog.mjs';
import { continuation, historyFingerprint, matchesHistory, toolAnswer, toolConfigFingerprint } from './history.mjs';
import { launchAgent } from './launch.mjs';
import { createModelDiscovery } from './model-discovery.mjs';
import { createAgentSession } from './session.mjs';
import { displayError } from './rpc.mjs';
import { createInferenceBudget, toolDeliveryError, trailingLocalResults } from './turn-lifecycle.mjs';
import { agyLaunchHash, createCheckpointStore } from './checkpoints.mjs';

export const providerId = 'local-cli';
export const baseURL = 'https://pi-local-cli.invalid/v1';
const maxConcurrent = 3;
const maxIdle = 4;
const maxBodyBytes = 2 * 1024 * 1024;
const turnMs = 5 * 60 * 1000;
const idleMs = 10 * 60 * 1000;
const maxParked = 8;
const settleMs = 60;

// A CLI's own quota or rate-limit message is a 429, not a broken upstream: it
// tells the caller to wait instead of retrying at once.
const rateLimited = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

function errorStatus(error) {
  if (error?.status) return error.status;
  if (error?.name === 'TimeoutError') return 504;
  return rateLimited.test(String(error?.message ?? '')) ? 429 : 502;
}

function jsonError(status, message) {
  const type = status < 500 && status !== 429 ? 'invalid_request_error' : 'upstream_error';
  return Response.json({ error: { type, message: displayError(message) } }, { status });
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Relay is the queue between what a CLI session produces and one HTTP
// response. It outlives a response: a parked conversation keeps pushing into
// it, and the caller's next request drains the same queue.
class Relay {
  #queue = [];
  #waiter;

  push(event) {
    if (this.#waiter) {
      const wake = this.#waiter;
      this.#waiter = undefined;
      wake(event);
    } else {
      this.#queue.push(event);
    }
  }

  unshift(event) {
    this.#queue.unshift(event);
  }

  take() {
    return this.#queue.shift();
  }

  next() {
    const event = this.#queue.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}

export function createBackend(root, {
  bridge, startBridge, checkpointDir, onProgress, inferenceMs = turnMs, toolWaitMs = 10 * 60 * 1000,
} = {}) {
  const retiring = new Set();
  const checkpoints = createCheckpointStore(checkpointDir);
  const lifetime = new AbortController();
  const { localModels, refreshCatalog, catalogAttempt } = createModelDiscovery(root, lifetime.signal);
  let running = 0;
  let stopped = false;
  let catalog = {};
  const turns = new Map();
  const pool = new Map();
  const parked = new Map();
  const lastStats = new Map();
  const progress = new Map();

  function report(record, phase, detail) {
    if (!record.caller || record.silent || stopped) return;
    const status = { phase, detail, model: record.modelLabel };
    progress.delete(record.caller);
    progress.set(record.caller, status);
    if (progress.size > 32) progress.delete(progress.keys().next().value);
    try { onProgress?.(record.caller, status); } catch { /* UI is observational. */ }
  }

  function loseDelivery(record, reason, phase = 'lost') {
    if (record.closed) return;
    record.failure.abort(toolDeliveryError());
    report(record, phase, reason);
    release(record);
  }

  function release(record) {
    if (!record || record.closed) return record?.retired;
    record.closed = true;
    const checkpoint = record.pendingCheckpoint ?? (record.checkpointHash && Promise.resolve(record.checkpointHash));
    turns.delete(record.id);
    pool.delete(record.id);
    parked.delete(record.id);
    clearTimeout(record.idleTimer);
    record.unwatchPark?.();
    record.budget?.pause();
    if (record.counted) {
      record.counted = false;
      running--;
    }
    if (record.attached) bridge?.close(record.attached.token);
    const done = (async () => {
      if (checkpoint) {
        try {
          const historyHash = await checkpoint;
          await record.session.retireAgySession();
          if (historyHash) await checkpoints.unlock(record.id, historyHash);
        } catch { /* A failed close keeps the lease guarded until process exit. */ }
      } else {
        record.session?.close();
      }
      await rm(record.dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }).catch(() => {});
    })().finally(() => retiring.delete(done));
    retiring.add(done);
    record.retired = done;
    return done;
  }

  // keepIdle parks a finished conversation's session for the next turn of the
  // same conversation, so it neither cold-starts nor re-reads its history.
  function keepIdle(record) {
    if (record.closed) return;
    record.callIds = undefined;
    record.budget?.pause();
    record.delivering = false;
    if (record.counted) {
      record.counted = false;
      running--;
    }
    clearTimeout(record.idleTimer);
    record.relay = new Relay();
    pool.set(record.id, record);
    record.idleTimer = setTimeout(() => release(record), idleMs);
    record.idleTimer.unref?.();
    for (const other of pool.values()) {
      if (pool.size <= maxIdle) break;
      if (other === record) continue;
      release(other);
    }
  }

  // openTurn launches a CLI with the caller's tools attached as MCP tools, so
  // the model calls them natively instead of through a text envelope.
  async function openTurn(agentId, model, request, toolConfig, signal, checkpoint) {
    signal.throwIfAborted();
    if (running >= maxConcurrent) throw statusError(429, 'All Local CLI request slots are in use.');
    const { tools, caller, effort } = request;
    running++;
    let dir;
    try { dir = await mkdtemp(join(tmpdir(), 'pi-local-cli-')); }
    catch (error) { running--; throw error; }
    const record = {
      id: randomUUID(), agent: agentId, model, dir, toolConfig, caller,
      relay: new Relay(), counted: true, effort, modelLabel: request.model,
      silent: request.silent, failure: new AbortController(),
    };
    turns.set(record.id, record);
    const abort = () => release(record);
    try {
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      if (stopped) throw statusError(503, 'The Local CLI provider has stopped.');
      if (tools.length) await startBridge?.();
      signal.throwIfAborted();
      const attached = tools.length ? bridge?.attach(tools) : undefined;
      record.attached = attached;
      if (attached) attached.record = record;
      const mcpServers = attached ? [attached.spec] : [];
      const launch = launchAgent(root, agentId, dir, { gateway: true, clientTools: Boolean(attached), mcpServers });
      if (checkpoints && agentId === 'antigravity' && caller && !record.silent) {
        record.launchHash = await agyLaunchHash(launch).catch(() => undefined);
      }
      signal.throwIfAborted();
      if (checkpoint && checkpoint.launchHash !== record.launchHash) throw new Error('Antigravity launch settings changed.');
      const session = createAgentSession(agentId, launch, (event) => {
        if (event.type === 'usage') record.stats = event;
        else if (event.type === 'text' || event.type === 'thought') record.relay.push(event);
        else if (event.type === 'error') record.relay.push({ type: 'error', error: new Error(event.message) });
      }, { gateway: true, model, tools, mcpServers, clientTools: Boolean(attached) });
      record.session = session;
      record.onToolCall = (call) => {
        if (!record.prompting) {
          bridge.answer(call.id, 'No Pi turn is accepting tool calls.', true);
          return;
        }
        record.relay.push({ type: 'call', call });
      };
      record.onToolDisconnect = (id) => {
        if (record.callIds?.includes(id) || record.deliveredIds?.includes(id)) {
          loseDelivery(record, 'The CLI bridge disconnected while transferring a Pi tool result.');
        }
      };
      await session.start({ resumeId: checkpoint?.sessionId });
      if (effort !== undefined) await session.setEffort(effort);
      record.restored = Boolean(checkpoint);
      signal.throwIfAborted();
      return record;
    } catch (error) {
      release(record);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  // collect gathers one tool call plus any siblings the CLI raised alongside it.
  async function collect(record, first) {
    const calls = [first];
    for (let index = 0; index < 8; index++) {
      await sleep(settleMs);
      const event = record.relay.take();
      if (!event) continue;
      if (event.type === 'call') calls.push(event.call);
      else { record.relay.unshift(event); break; }
    }
    return calls;
  }

  async function pump(record, emit, { parallel, signal }) {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const event = await Promise.race([record.relay.next(), aborted.promise]);
        if (event.type === 'text' || event.type === 'thought') { emit(event.text, event.type); continue; }
        if (event.type === 'end') return { reason: event.reason, usage: record.stats?.usage };
        if (event.type === 'error') throw event.error;
        if (event.type === 'call') {
          const calls = await Promise.race([collect(record, event.call), aborted.promise]);
          if (record.session.closed || !record.prompting || calls.some(call => !bridge.has(call.id))) {
            throw statusError(502, 'The CLI disconnected before its tool call could be dispatched.');
          }
          if (parallel === false) {
            for (const extra of calls.slice(1)) bridge.answer(extra.id, 'Parallel tool calls are disabled for this request.', true);
            calls.length = 1;
          }
          return { reason: 'tool_calls', toolCalls: calls };
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  function claimTurn(agent, model, toolConfig, request, fingerprints) {
    const { messages } = request;
    for (const record of parked.values()) {
      // A turn that is already running cannot change model, so this one must match.
      if (record.model !== model || record.effort !== request.effort) continue;
      if (record.session.closed) { release(record); continue; }
      if (record.agent !== agent || !matchesHistory(record, toolConfig, request, fingerprints)) continue;
      const results = messages.slice(record.historyLength);
      const ids = new Set(results.map((result) => result.tool_call_id));
      if (results.length !== record.callIds.length || ids.size !== results.length ||
          results.some((result) => result.role !== 'tool') || !record.callIds.every((id) => ids.has(id) && bridge?.has(id))) continue;
      parked.delete(record.id);
      clearTimeout(record.idleTimer);
      record.unwatchPark?.();
      return { record, results };
    }
    for (const record of pool.values()) {
      if (record.model !== model || record.effort !== request.effort) continue;
      if (record.session.closed) { release(record); continue; }
      if (record.agent !== agent || !matchesHistory(record, toolConfig, request, fingerprints)) continue;
      const followUp = continuation(record.historyLength, request);
      if (!followUp) continue;
      pool.delete(record.id);
      clearTimeout(record.idleTimer);
      return { record, ...followUp };
    }
    return {};
  }

  async function recoverTurn(agent, model, request, toolConfig, fingerprints, signal) {
    if (agent !== 'antigravity' || !checkpoints || request.silent || !request.caller) return undefined;
    const checkpoint = await checkpoints.take(request.caller, row =>
      row.model === request.model && row.nativeModel === (model ?? '') && row.effort === (request.effort ?? '') &&
      matchesHistory({ ...row, caller: request.caller }, toolConfig, request, fingerprints) &&
      Boolean(continuation(row.historyLength, request)));
    if (!checkpoint) return undefined;
    signal.throwIfAborted();
    const followUp = continuation(checkpoint.historyLength, request);
    try {
      const resumeSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const record = await openTurn(agent, model, request, toolConfig, resumeSignal, checkpoint);
      return { record, ...followUp };
    } catch {
      signal.throwIfAborted();
      // Resume failed before a prompt was sent, so a fresh session is safe.
      return undefined;
    }
  }

  function park(record, calls, signal) {
    record.callIds = calls.map((call) => call.id);
    record.budget.pause();
    record.counted = false;
    running--;
    parked.set(record.id, record);
    report(record, 'waiting', `${calls.length} Pi tool result(s) pending.`);
    const cancel = () => loseDelivery(record, 'Tool waiting was cancelled. No continuation will be replayed.', 'cancelled');
    record.unwatchPark = () => {
      signal?.removeEventListener('abort', cancel);
      record.unwatchPark = undefined;
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    if (record.session.closed || record.callIds.some(id => !bridge.has(id))) {
      loseDelivery(record, 'The CLI disconnected while waiting for Pi tools.');
      return;
    }
    record.idleTimer = setTimeout(() => loseDelivery(record, 'The wait for Pi tool results expired.'), toolWaitMs);
    record.idleTimer.unref?.();
    if (parked.size > maxParked) loseDelivery(parked.values().next().value, 'The queue for pending Pi tools reached its limit.');
  }

  async function fetchLocal(input, init, { caller = '', expectedModel, disableContinuation = false, cancelSignal } = {}) {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const signal = AbortSignal.any([init?.signal ?? (input instanceof Request ? input.signal : undefined), lifetime.signal].filter(Boolean));
    signal.throwIfAborted();
    if (url !== `${baseURL}/chat/completions` || method !== 'POST') return jsonError(404, 'Local CLI supports only its in-process Chat Completions endpoint.');
    let request;
    try {
      const body = init?.body ?? (input instanceof Request ? await input.text() : null);
      if (typeof body !== 'string' || Buffer.byteLength(body) > maxBodyBytes) throw new Error('A JSON chat request of at most 2 MiB is required.');
      const parsed = JSON.parse(body);
      if (expectedModel && parsed?.model !== expectedModel) throw new Error('Local CLI request model does not match the selected model.');
      // Chat Completions may send reasoning_effort="none" for Pi's off setting.
      if (parsed?.reasoning_effort === 'none') delete parsed.reasoning_effort;
      if (parsed?.tool_choice === 'none') delete parsed.tools;
      request = parseChatRequest(parsed);
    } catch (error) { return jsonError(400, error.message); }
    const agent = localModels().find(({ id }) => request.model.startsWith(`${id}-`));
    if (!agent) return jsonError(404, 'This local CLI is unavailable. Install it and sign in from the terminal.');
    const native = request.model.slice(agent.id.length + 1);
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(native)) return jsonError(400, 'Invalid native model ID.');
    if (request.tools.length && !bridge) return jsonError(503, 'This host cannot serve tools for local CLI models.');
    request.caller = caller;
    request.silent = disableContinuation;
    let model = native === 'default' ? undefined : native;
    if (agent.id === 'antigravity' && model) {
      const saved = catalog[agent.id];
      const variants = agyModelFamilies(saved?.models ?? []).get(model);
      if (variants) {
        const effort = request.effort ?? (variants.has('high') ? 'high' : [...effortValues].reverse().find((value) => variants.has(value)));
        const selected = variants.get(effort);
        if (!selected) return jsonError(400, `Antigravity model ${model} offers these reasoning levels: ${[...variants.keys()].join(', ')}.`);
        model = selected.id;
        request.effort = undefined; // The native model ID already selects the effort.
      }
    } else if (agent.id !== 'antigravity' && request.effort === 'max') {
      return jsonError(400, 'The max reasoning level is only supported by Antigravity.');
    }

    const { messages, parallelToolCalls } = request;
    const toolConfig = toolConfigFingerprint(request);
    let active;
    let outcome;
    try {
      return await serveChat(request, async ({ signal: clientSignal, emit }) => {
        if (stopped) throw statusError(503, 'The Local CLI provider has stopped.');
        const localResults = trailingLocalResults(messages);
        if (localResults && disableContinuation) throw toolDeliveryError();
        if (running >= maxConcurrent) throw statusError(429, 'All Local CLI request slots are in use.');
        const setupSignal = AbortSignal.any([clientSignal, AbortSignal.timeout(turnMs)]);
        // `prompt` is undefined when the CLI continues a turn it never left.
        const begin = (record, prompt, images = request.images) => {
          active = record;
          if (prompt === undefined) return;
          clientSignal.throwIfAborted();
          record.stats = undefined;
          record.deliveredIds = undefined;
          record.budget = createInferenceBudget(inferenceMs);
          record.budget.resume();
          record.prompting = true;
          report(record, 'running', 'The CLI is generating a response.');
          void record.session.prompt(prompt, images, { managedTimeout: true }).then(
            (reason) => {
              if (parked.has(record.id)) loseDelivery(record, 'The CLI ended its turn before Pi tool results returned.');
              else record.relay.push({ type: 'end', reason });
            },
            (error) => {
              if (parked.has(record.id)) loseDelivery(record, 'The CLI closed while waiting for Pi tools.');
              else record.relay.push({ type: 'error', error });
            },
          ).finally(() => { record.prompting = false; });
        };
        const fresh = async () => {
          report({ caller, modelLabel: request.model, silent: disableContinuation }, 'running', 'Starting the CLI.');
          begin(await openTurn(agent.id, model, request, toolConfig, setupSignal), request.prompt);
        };
        const fingerprints = new Map();
        const claimed = disableContinuation ? {} : claimTurn(agent.id, model, toolConfig, request, fingerprints);
        if (!claimed.record) {
          if (localResults) throw toolDeliveryError();
          const restored = await recoverTurn(agent.id, model, request, toolConfig, fingerprints, setupSignal);
          if (restored) begin(restored.record, restored.prompt, restored.images);
          else await fresh();
        } else {
          active = claimed.record;
          active.counted = true;
          running++;
          clientSignal.throwIfAborted();
          if (claimed.results) {
            active.delivering = true;
            active.deliveredIds = [...(active.deliveredIds ?? []), ...active.callIds];
            active.budget.resume();
            active.budget.signal.throwIfAborted();
            active.failure.signal.throwIfAborted();
            const delivered = claimed.results.every((result, offset) => bridge.answer(
              result.tool_call_id,
              toolAnswer(result, request.images.filter((image) => image.at === active.historyLength + offset)),
            ));
            if (!delivered) {
              loseDelivery(active, 'The CLI bridge no longer accepts the Pi tool result.');
              throw toolDeliveryError();
            }
            report(active, 'running', 'Tool result sent to the bridge; CLI response pending.');
          } else {
            // Invalidate the previous recovery point before mutating its native history.
            if (active.checkpointHash && !await checkpoints.markBusy(active.id)) {
              release(active);
              await fresh();
            } else {
              active.checkpointHash = undefined;
              active.restored = false;
              active.reused = true;
              begin(active, claimed.prompt, claimed.images);
            }
          }
        }
        try {
          const runSignal = AbortSignal.any([clientSignal, active.budget.signal, active.failure.signal]);
          outcome = await pump(active, emit, { parallel: parallelToolCalls, signal: runSignal });
          if (active.delivering && ['cancelled', 'canceled', 'interrupted', 'aborted'].includes(outcome.reason)) {
            throw toolDeliveryError();
          }
          return outcome;
        } catch (error) {
          if (active.delivering && !clientSignal.aborted) {
            loseDelivery(active, 'The CLI did not finish after Pi returned its tool result.');
            throw toolDeliveryError();
          }
          release(active);
          throw error;
        }
      }, signal, {
        async onReply(message) {
          if (!active || active.closed) return;
          active.historyLength = messages.length + 1;
          active.historyHash = historyFingerprint(request, active.historyLength, message);
          if (message.tool_calls?.length) {
            park(active, message.tool_calls, cancelSignal ?? signal);
            return;
          }
          const completed = ['completed', 'end_turn', 'stop', 'max_tokens', 'max_turn_requests'].includes(outcome.reason);
          if (!completed) report(active, 'cancelled', 'The CLI turn ended without completing.');
          if (completed && !disableContinuation) {
            let completion = 'The CLI finished.';
            if (active.restored) completion = 'The CLI finished (Antigravity session restored).';
            else if (active.reused) completion = 'The CLI finished (native process reused).';
            report(active, 'done', completion);
            lastStats.delete(caller);
            lastStats.set(caller, {
              ...active.stats, model: request.model, at: Date.now(),
            });
            if (lastStats.size > 32) lastStats.delete(lastStats.keys().next().value);
            if (active.launchHash && active.session.canCheckpoint && !signal.aborted) {
              const historyHash = active.historyHash;
              active.pendingCheckpoint = checkpoints.save(active.caller, {
                ...active, sessionId: active.session.sessionId, model: active.modelLabel,
                nativeModel: active.model ?? '', effort: active.effort ?? '',
              }, active.id).then(saved => saved ? historyHash : undefined).catch(() => undefined);
              active.checkpointHash = await active.pendingCheckpoint;
              active.pendingCheckpoint = undefined;
            }
            keepIdle(active);
          } else {
            release(active);
          }
        },
        onStreamError: ({ cancelled }) => {
          if (active && progress.get(caller)?.phase !== 'lost') {
            report(active, cancelled || signal.aborted ? 'cancelled' : 'error',
              cancelled || signal.aborted ? 'The Local CLI request was cancelled.' : 'The Local CLI request failed.');
          }
          release(active);
        },
      });
    } catch (error) {
      release(active);
      if (signal?.aborted) throw signal.reason;
      if (error?.status === 409 && ['done', undefined].includes(progress.get(caller)?.phase)) {
        report({ caller, modelLabel: request.model, silent: disableContinuation }, 'lost', 'The original CLI turn cannot accept this result. No continuation was replayed.');
      }
      if (error?.status !== 409 && !active) {
        report({ caller, modelLabel: request.model, silent: disableContinuation }, 'error', 'The CLI could not start.');
      }
      return jsonError(errorStatus(error), error.message);
    }
  }

  return {
    fetch: fetchLocal,
    refreshCatalog,
    setCatalog(next) { catalog = next; },
    lastUsage(caller) { return lastStats.get(caller); },
    turnStatus(caller) { return progress.get(caller); },
    catalogAttempt,
    stop() {
      stopped = true;
      lifetime.abort();
      for (const record of turns.values()) release(record);
      return Promise.all(retiring);
    },
  };
}
