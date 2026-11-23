import { randomUUID } from 'node:crypto';
import { Rpc } from '../rpc.mjs';

export const maxTurnMs = 30 * 60 * 1000;
export const clientInfo = { name: 'pi-local-cli', title: 'Pi Local CLI', version: '0.1.0' };

export function boundedText(value, size = 4096) {
  return typeof value === 'string' ? value.slice(0, size) : '';
}

export const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function completionUsage(input, output, cached, reasoning, cacheWrite) {
  const total = input + output;
  if (!isTokenCount(input) || !isTokenCount(output) || !isTokenCount(total)) return undefined;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: total };
  const promptDetails = {};
  if (isTokenCount(cached) && cached <= input) promptDetails.cached_tokens = cached;
  if (isTokenCount(cacheWrite) && cacheWrite <= input - (promptDetails.cached_tokens ?? 0)) {
    promptDetails.cache_write_tokens = cacheWrite;
  }
  if (Object.keys(promptDetails).length) usage.prompt_tokens_details = promptDetails;
  if (isTokenCount(reasoning) && reasoning <= output) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

export class SessionConnection {
  #approvals = new Map();
  // Set by the backend while a caller's tool call is parked.
  onToolCall;

  constructor(agent, launch, emit, gateway) {
    this.agent = agent;
    this.cwd = launch.cwd;
    this.emit = emit;
    this.gateway = gateway;
    this.rpc = new Rpc(launch);
  }

  bind({ notify, handleRequest, onClose }) {
    this.rpc.onNotification = notify;
    this.rpc.onRequest = handleRequest;
    this.rpc.onClose = (error) => {
      this.clearApprovals();
      onClose?.(error);
    };
  }

  get closed() { return this.rpc.closed; }
  get canCheckpoint() { return false; }

  setSink(sink) { this.emit = sink; }

  emitStarted() {
    if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error('The CLI did not return a session ID.');
    this.emit({ type: 'session', sessionId: this.sessionId });
  }

  close() {
    this.rpc.close();
    this.clearApprovals();
  }

  decide(id, optionId) {
    const approval = this.#approvals.get(id);
    if (approval?.options.some((option) => option.id === optionId)) approval.finish(optionId);
  }

  clearApprovals() {
    for (const approval of this.#approvals.values()) approval.finish(null);
  }

  ask(title, detail, options) {
    if (!options.length) return null;
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (option) => {
        clearTimeout(timer);
        this.#approvals.delete(id);
        this.emit({ type: 'resolved', id });
        resolve(option);
      };
      const timer = setTimeout(() => finish(null), 120000);
      this.#approvals.set(id, { options, finish });
      this.emit({ type: 'permission', id, title, detail, options });
    });
  }
}
