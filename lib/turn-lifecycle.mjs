import { performance } from 'node:perf_hooks';

const callPrefix = 'call_pi_local_';

export const localToolCallId = (uuid) => callPrefix + uuid.replaceAll('-', '');

export function trailingLocalResults(messages) {
  for (let index = messages.length - 1; index >= 0 && messages[index].role === 'tool'; index--) {
    if (/^call_pi_local_[a-f0-9]{32}$/.test(messages[index].tool_call_id)) return true;
  }
  return false;
}

export function toolDeliveryError() {
  return Object.assign(new Error('Local CLI tool result could not be delivered or confirmed. The Pi tool may already have run. Check the tool output in the conversation before trying again. This continuation was not replayed.'), { status: 409 });
}

// One budget per native prompt. Waiting for Pi is not inference time.
export function createInferenceBudget(ms) {
  const controller = new AbortController();
  let remaining = ms;
  let started;
  let timer;
  function pause() {
    if (started === undefined) return;
    clearTimeout(timer);
    remaining -= performance.now() - started;
    started = undefined;
  }
  function resume() {
    if (started !== undefined || controller.signal.aborted) return;
    const expire = () => controller.abort(Object.assign(new Error('Local CLI inference time limit exceeded.'), { status: 504 }));
    if (remaining <= 0) { expire(); return; }
    started = performance.now();
    timer = setTimeout(expire, remaining);
    timer.unref?.();
  }
  return { signal: controller.signal, pause, resume };
}
