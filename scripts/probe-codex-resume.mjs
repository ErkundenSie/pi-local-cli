import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchAgent } from '../lib/launch.mjs';
import { Rpc } from '../lib/rpc.mjs';

// Runs one real, tool-free inference. It never creates a persistent thread or
// reads a user's prior thread. A disposable Codex workspace is used each time.
const model = process.argv[2] ?? 'gpt-6.2-sol';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model)) throw new Error('Expected a native Codex model ID');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'pi-codex-ephemeral-'));
let rpc;

async function connect() {
  const cwd = await mkdtemp(join(scratch, 'work-'));
  rpc = new Rpc(launchAgent(root, 'codex', cwd, { gateway: true }));
  const init = await rpc.request('initialize', { clientInfo: { name: 'pi-local-cli-probe', version: '0.1.0' } }, 8000);
  rpc.notify('initialized');
  return { cwd, init };
}

async function dispose() {
  if (!rpc) return;
  rpc.close();
  const closed = await Promise.race([rpc.exited.then(() => true), delay(5000, false)]);
  if (!closed) throw new Error('The previous App Server did not exit');
  rpc = undefined;
}

try {
  const { cwd, init } = await connect();
  console.log('App Server:', init.userAgent ?? '(version not reported)');
  const policy = { model, modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never' };
  const started = await rpc.request('thread/start', { cwd, ...policy, ephemeral: true }, 10000);
  const threadId = started.thread?.id;
  if (!threadId || started.thread?.path || started.thread?.ephemeral === false) {
    throw new Error('Codex did not create the expected ephemeral thread');
  }
  const completed = Promise.withResolvers();
  let hasText = false;
  rpc.onNotification = (method, params) => {
    if (params.threadId !== threadId) return;
    if (method === 'item/agentMessage/delta' && params.delta?.trim()) hasText = true;
    if (method === 'turn/completed') completed.resolve(params.turn);
  };
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply only OK. Do not call tools.', text_elements: [] }] }, 12000);
  const turn = await Promise.race([completed.promise, delay(40000, undefined, { ref: false })]);
  if (turn?.status !== 'completed' || !hasText) throw new Error(turn?.error?.message ?? 'The probe did not complete a text turn');
  console.log('Ephemeral thread completed a real turn (no rollout path).');
  await dispose();
  const { cwd: nextCwd } = await connect();
  const resume = { threadId, cwd: nextCwd, ...policy };
  for (const [method, params] of [['thread/read', { threadId, includeTurns: true }], ['thread/resume', resume]]) {
    try {
      const result = await rpc.request(method, params, 12000);
      console.log(`${method} accepted: same thread ${result.thread?.id === threadId}; turns returned: ${result.thread?.turns?.length ?? 'unknown'}`);
    } catch (error) {
      console.log(`${method} refused: ${error.message}`);
    }
  }
} finally {
  try { await dispose(); }
  finally { await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); }
}
