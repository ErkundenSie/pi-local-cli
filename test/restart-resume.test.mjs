import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createBridgeServer } from '../lib/bridge-server.mjs';
import { baseURL, createBackend } from '../lib/provider.mjs';
import { createCheckpointStore } from '../lib/checkpoints.mjs';

const fixture = fileURLToPath(new URL('./fixture-resume.mjs', import.meta.url));
const first = { role: 'user', content: 'private previous input' };
const next = { role: 'user', content: 'continue' };

async function harness(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'pi-local-restart-test-'));
  const checkpointDir = join(root, 'state');
  const active = [];
  t.after(async () => {
    await Promise.all(active.map(instance => instance.stop()));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, '.local-agents.json'), JSON.stringify({
    executables: { antigravity: { path: process.execPath, args: [fixture, ...(mode ? [mode] : [])] } },
  }));

  function open() {
    const mcp = createBridgeServer();
    const backend = createBackend(root, { checkpointDir, bridge: mcp.bridge, startBridge: mcp.start });
    const instance = {
      backend,
      async stop() { await Promise.all([backend.stop(), mcp.stop()]); },
      chat: (messages, options = {}) => backend.fetch(`${baseURL}/chat/completions`, {
        method: 'POST', body: JSON.stringify({ messages, model: 'antigravity-default', ...options }),
      }, { caller: 'session-1' }),
    };
    active.push(instance);
    return instance;
  }
  return { open, checkpointDir };
}

async function ask(client, messages) {
  const response = await client.chat(messages);
  assert.equal(response.status, 200);
  return (await response.json()).choices[0].message;
}

test('a completed turn resumes on a new backend and sends only the suffix', async t => {
  const { open, checkpointDir } = await harness(t);
  const before = open();
  const reply = await ask(before, [first]);
  const names = (await readdir(checkpointDir)).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  const file = await readFile(join(checkpointDir, names[0]), 'utf8');
  assert.doesNotMatch(file, /private previous input|first response|session-1/);
  assert.ok(JSON.parse(file).historyHash);
  await before.stop();
  const after = open();
  const resumed = await ask(after, [first, reply, next]);
  assert.equal(resumed.content, 'resumed delta only');
  assert.match(after.backend.turnStatus('session-1').detail, /restored/);
});

for (const kind of ['edited', 'compacted', 'rejected']) {
  test(`${kind} history or rejected resume opens a fresh session`, async t => {
    const { open } = await harness(t, kind === 'rejected' ? 'reject-resume' : undefined);
    const before = open();
    const reply = await ask(before, [first]);
    await before.stop();
    const messages = kind === 'edited' ? [first, { ...reply, content: 'edited' }, next]
      : kind === 'compacted' ? [{ role: 'system', content: 'summary' }, next]
        : [first, reply, next];
    assert.equal((await ask(open(), messages)).content, 'first response');
  });
}

test('hot follow-ups keep the same native process while live checkpoints are private', async t => {
  const { open, checkpointDir } = await harness(t);
  const client = open();
  const reply = await ask(client, [first]);
  const store = createCheckpointStore(checkpointDir);
  assert.equal(await store.take('session-1', () => true), undefined);
  const result = await ask(client, [first, reply, next]);
  assert.equal(result.content, 'first response');
  assert.match(client.backend.turnStatus('session-1').detail, /reused/);
  await client.stop();
  assert.equal((await store.take('session-1', () => true)).historyLength, 4);
});

test('a parked tool remains non-resumable and its late result returns 409', async t => {
  const { open, checkpointDir } = await harness(t);
  const before = open();
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  const user = { role: 'user', content: 'fixture tool' };
  const response = await before.chat([user], { tools });
  const { message, finish_reason } = (await response.json()).choices[0];
  assert.equal(finish_reason, 'tool_calls');
  await before.stop();
  await assert.rejects(readdir(checkpointDir), { code: 'ENOENT' });
  const late = await open().chat([user, message, {
    role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'fixture tool output',
  }], { tools });
  assert.equal(late.status, 409);
});

test('a busy lease does not become restorable after an interrupted turn', async t => {
  const { checkpointDir } = await harness(t);
  const store = createCheckpointStore(checkpointDir);
  const token = randomUUID();
  const hash = 'b'.repeat(64);
  const row = { sessionId: randomUUID(), model: 'antigravity-default', nativeModel: '', effort: '', historyLength: 2,
    historyHash: hash, toolConfig: hash, launchHash: hash };
  assert.equal(await store.save('scope', row, token), true);
  assert.equal(await store.take('scope', () => true), undefined);
  assert.equal(await store.markBusy(token), true);
  const lease = join(checkpointDir, token + '.lease');
  await writeFile(lease, JSON.stringify({ pid: 0, historyHash: null }));
  assert.equal(await store.take('scope', () => true), undefined);
});

test('a checkpoint claim is exclusive and expires', async t => {
  const { checkpointDir } = await harness(t);
  let now = Date.now();
  const store = createCheckpointStore(checkpointDir, { now: () => now, ttlMs: 1000 });
  const hash = 'a'.repeat(64);
  const row = { sessionId: randomUUID(), model: 'antigravity-default', nativeModel: '', effort: '', historyLength: 2,
    historyHash: hash, toolConfig: hash, launchHash: hash };
  await store.save('scope', row);
  const candidates = await Promise.all([store.take('scope', () => true), store.take('scope', () => true)]);
  assert.equal(candidates.filter(Boolean).length, 1);
  await store.save('scope', row);
  now += 1001;
  assert.equal(await store.take('scope', () => true), undefined);
});
