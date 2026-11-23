import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createBridgeServer } from '../lib/bridge-server.mjs';
import { catalogModels, restoreCatalog } from '../lib/catalog.mjs';
import { createBackend, baseURL } from '../lib/provider.mjs';

const fixture = (name) => fileURLToPath(new URL(name, import.meta.url));
const question = { role: 'user', content: '请回答' };
const lookup = {
  type: 'function',
  function: { name: 'lookup', description: 'Find a record', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
};

async function harness(t, agyMode = 'normal', timeouts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-local-cli-test-'));
  await writeFile(join(root, '.local-agents.json'), JSON.stringify({
    executables: {
      codex: { path: process.execPath, args: [fixture('fixture-tools.mjs')] },
      grok: { path: process.execPath, args: [fixture('fixture.mjs'), 'grok'] },
      antigravity: { path: process.execPath, args: [fixture('fixture.mjs'), 'antigravity', agyMode] },
    },
  }));
  const mcp = createBridgeServer();
  const backend = createBackend(root, { bridge: mcp.bridge, startBridge: mcp.start, ...timeouts });
  t.after(async () => {
    await Promise.all([backend.stop(), mcp.stop()]);
    await rm(root, { recursive: true, force: true });
  });
  return {
    backend,
    chat: (body = {}, signal, caller = 'session-a', disableContinuation = false) => backend.fetch(
      `${baseURL}/chat/completions`, {
        method: 'POST', signal,
        body: JSON.stringify({ model: 'codex-default', messages: [question], ...body }),
      }, { caller, disableContinuation }),
  };
}

test('discovers models and streams text and usage from Codex', async (t) => {
  const { backend, chat } = await harness(t);
  const { next, changed } = await backend.refreshCatalog({});
  assert.equal(changed, true);
  const restored = restoreCatalog(JSON.parse(JSON.stringify({ piLocalCliCatalog: next })));
  const ids = catalogModels(restored).map(({ id }) => id);
  assert.ok(ids.includes('codex-test-model'));
  assert.ok(ids.includes('antigravity-model-b'));
  const warm = await backend.refreshCatalog(restored);
  assert.equal(warm.changed, false);
  assert.deepEqual(warm.next, restored);
  const res = await chat({ stream: true, stream_options: { include_usage: true } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text();
  assert.match(body, /before tool/);
  assert.match(body, /no tool server/);
  assert.match(body, /"total_tokens":120/);
  assert.match(body, /data: \[DONE\]/);
});

test('falls back to agy models when ACP omits a catalog', async (t) => {
  const { backend } = await harness(t, 'catalog-fallback');
  const { next } = await backend.refreshCatalog({});
  const saved = restoreCatalog({ piLocalCliCatalog: next });
  assert.equal(saved.antigravity.source, 'agy-models');
  assert.deepEqual(saved.antigravity.models.map(row => row.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low']);
  assert.deepEqual(catalogModels(saved).find(row => row.id === 'antigravity-gemini-3.8-flash')?.efforts, ['high', 'low']);
  assert.match(backend.catalogAttempt('antigravity').note, /acp: no models returned/);
});

test('maps a CLI effort suffix only when ACP offers its base model and effort', async (t) => {
  const { chat } = await harness(t, 'base-effort');
  const res = await chat({ model: 'antigravity-gemini-3.8-flash-high', messages: [{ role: 'user', content: 'probe' }] });
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.match(answer.choices[0].message.content, /model:gemini-3\.8-flash effort:high/);
});

test('parks a real MCP round-trip and resumes only the matching Pi conversation', async (t) => {
  const { chat, backend } = await harness(t);
  const first = await (await chat({ stream: true, tools: [lookup] })).text();
  const chunks = first.trim().split('\n\n').filter(line => line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  const delta = chunks.flatMap(chunk => chunk.choices).find(choice => choice.delta.tool_calls);
  assert.equal(delta.finish_reason, null);
  const { index, ...call } = delta.delta.tool_calls[0];
  assert.equal(index, 0);
  assert.equal(call.function.name, 'lookup');
  assert.deepEqual(JSON.parse(call.function.arguments), { query: 'fixture' });
  const followUp = {
    tools: [lookup],
    messages: [
      question,
      { role: 'assistant', content: 'before tool', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '42' },
    ],
  };
  const wrong = await chat(followUp, undefined, 'session-b');
  assert.equal(wrong.status, 409);
  const edited = structuredClone(followUp);
  edited.messages[0].content = 'Different branch';
  assert.equal((await chat(edited)).status, 409);
  const answer = await (await chat(followUp)).json();
  assert.equal(answer.choices[0].message.content, '; tool said 42');
  assert.equal(answer.usage.total_tokens, 120);
  const stats = backend.lastUsage('session-a');
  assert.equal(stats.usageSource, 'codex-last');
  assert.equal(stats.turnUsage.total_tokens, 240);
  assert.equal(stats.context.size, 500_000);
  assert.equal(backend.lastUsage('unrelated'), undefined);
  assert.equal((await chat(followUp)).status, 409);
});

async function startTool(chat, content = 'lookup', signal) {
  const user = { role: 'user', content };
  const response = await chat({ tools: [lookup], messages: [user] }, signal);
  assert.equal(response.status, 200);
  const { message, finish_reason } = (await response.json()).choices[0];
  assert.equal(finish_reason, 'tool_calls');
  assert.match(message.tool_calls[0].id, /^call_pi_local_[a-f0-9]{32}$/);
  return { tools: [lookup], messages: [user, message, {
    role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'slow result',
  }] };
}

test('waiting longer than the inference budget still delivers results to the parked CLI', async (t) => {
  const { chat, backend } = await harness(t, 'normal', { inferenceMs: 2500, toolWaitMs: 8000 });
  const next = await startTool(chat);
  assert.equal(backend.turnStatus('session-a').phase, 'waiting');
  await delay(2650);
  assert.equal(backend.turnStatus('session-a').phase, 'waiting');
  const result = await chat(next);
  assert.equal(result.status, 200);
  assert.match((await result.json()).choices[0].message.content, /tool said slow result/);
  assert.equal(backend.turnStatus('session-a').phase, 'done');
});

test('expired tool waits are rejected without replay', async (t) => {
  const { chat, backend } = await harness(t, 'normal', { toolWaitMs: 180 });
  const next = await startTool(chat);
  await delay(250);
  assert.match(backend.turnStatus('session-a').detail, /expired/);
  const result = await chat(next);
  assert.equal(result.status, 409);
  assert.match((await result.json()).error.message, /was not replayed/);
});

test('cancellation while waiting closes the CLI and rejects a late tool result', async (t) => {
  const { chat, backend } = await harness(t);
  const controller = new AbortController();
  const next = await startTool(chat, 'lookup', controller.signal);
  controller.abort();
  assert.equal(backend.turnStatus('session-a').phase, 'cancelled');
  assert.equal((await chat(next)).status, 409);
});

for (const fault of ['process', 'bridge']) {
  test(`lost ${fault} while waiting prevents replay`, async (t) => {
    const { chat, backend } = await harness(t);
    const next = await startTool(chat, `drop ${fault}`);
    for (let i = 0; i < 60 && backend.turnStatus('session-a').phase === 'waiting'; i++) await delay(50);
    assert.equal(backend.turnStatus('session-a').phase, 'lost');
    const result = await chat(next);
    assert.equal(result.status, 409);
    assert.match((await result.json()).error.message, /may already have run/);
  });
}

test('denies undeclared ACP permissions, preserves Unicode, and reuses history', async (t) => {
  const { chat, backend } = await harness(t);
  const request = { model: 'antigravity-default' };
  const first = (await (await chat(request)).json()).choices[0].message;
  assert.equal(first.content, '回合 1: no');
  assert.deepEqual(backend.lastUsage('session-a').context, { used: 999, size: 2000 });
  const next = { ...request, messages: [question, first, { role: 'user', content: '继续' }] };
  assert.equal((await (await chat(next)).json()).choices[0].message.content, '回合 2: no');
  assert.equal((await (await chat(next, undefined, 'session-a', true)).json()).choices[0].message.content, '回合 1: no');
});

test('sends inline images and does not expose tools with tool_choice none', async (t) => {
  const { chat } = await harness(t);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const response = await chat({ tools: [lookup], tool_choice: 'none', messages: [
    { role: 'user', content: [{ type: 'text', text: 'probe' }, { type: 'image_url', image_url: { url: image } }] },
  ] });
  assert.equal((await response.json()).choices[0].message.content, 'text,image:data:image/png;base64,');
  const noTools = await (await chat({ tools: [lookup], tool_choice: 'none' })).json();
  assert.match(noTools.choices[0].message.content, /no tool server/);
});

test('aborts an in-flight ACP turn promptly', async (t) => {
  const { chat } = await harness(t);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(chat({ model: 'antigravity-default', messages: [{ role: 'user', content: 'wait' }] }, controller.signal),
      { name: 'AbortError' });
  } finally {
    clearTimeout(deadline);
  }
  const next = await chat({ model: 'antigravity-default' });
  assert.equal(next.status, 200);
});

test('does not substitute cumulative Codex usage when last inference is missing', async (t) => {
  const { chat, backend } = await harness(t);
  const res = await chat({ messages: [{ role: 'user', content: 'only cumulative' }] });
  assert.equal((await res.json()).usage, undefined);
  assert.equal(backend.lastUsage('session-a').usageSource, undefined);
  assert.equal(backend.lastUsage('session-a').turnUsage.total_tokens, 120);
});

test('surfaces the Grok ACP 402 status without copying private upstream error data', async (t) => {
  const { chat } = await harness(t);
  const res = await chat({ model: 'grok-default', stream: true, messages: [{ role: 'user', content: 'fixture billing error' }] });
  assert.equal(res.status, 402);
  const data = (await res.json()).error;
  assert.match(data.message, /HTTP 402.*usage balance exhausted/);
  assert.doesNotMatch(data.message, /fixture-private-provider-detail/);
});

test('rejects tool requests without a live MCP bridge', async (t) => {
  const { chat } = await harness(t, 'normal', { bridge: undefined });
  const res = await chat({ tools: [lookup] });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /cannot serve tools/);
});

test('forwards history and inline images that exceed the old 2 MiB limit', async (t) => {
  const { chat } = await harness(t);
  const png = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  const res = await chat({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'probe' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ] }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'text,image:data:image/png;base64,');
});

test('distinguishes oversized requests and transcripts from malformed JSON', async (t) => {
  const { chat, backend } = await harness(t);
  const endpoint = `${baseURL}/chat/completions`;
  const malformed = await backend.fetch(endpoint, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error.message, /Malformed JSON/);
  const body = await chat({ messages: [{ role: 'user', content: 'x'.repeat(64 * 1024 * 1024) }] });
  assert.equal(body.status, 413);
  assert.equal((await body.json()).error.code, 'request_too_large');
  const text = await chat({ messages: [{ role: 'user', content: '界'.repeat(11_200_000) }] });
  assert.equal(text.status, 413);
  assert.match((await text.json()).error.message, /text transcript exceeds 32 MiB/);

  const oversized = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(33 * 1024 * 1024);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const streaming = await backend.fetch(new Request(endpoint, { method: 'POST', body: oversized, duplex: 'half' }));
  assert.equal(streaming.status, 413);
});

test('returns quota failures and does not route unknown URLs to the network', async (t) => {
  const { chat, backend } = await harness(t);
  const limited = await chat({ messages: [{ role: 'user', content: 'rate limited' }], stream: true });
  assert.equal(limited.status, 429);
  assert.equal((await backend.fetch('https://example.invalid/v1/chat/completions', { method: 'POST' })).status, 404);
});
