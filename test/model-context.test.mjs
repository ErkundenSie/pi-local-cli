import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogContextWindows, grokContextWindows, modelContextWindow } from '../lib/model-context.mjs';

const budget = (agent, id, windows) => modelContextWindow({ agent, id: `${agent}-${id}` }, windows);

test('uses Antigravity budgets for exact families and reasoning variants only', () => {
  for (const [id, tokens] of [
    ['gemini-4-neon', 512_000], ['gemini-4-carbon', 1_000_000],
    ['gemini-4-argon', 1_000_000], ['gemini-4-hydrogen', 1_000_000],
    ['gemini-3.8-flash', 1_000_000], ['claude-opus-5-5', 1_000_000],
    ['claude-sonnet-5-5', 1_000_000], ['gpt-oss-120b', 131_072],
  ]) {
    assert.equal(budget('antigravity', id), tokens);
    assert.equal(budget('antigravity', `${id}-high`), tokens);
  }
  for (const id of ['default', 'gemini-4-neon-preview']) {
    assert.equal(budget('antigravity', id), 128_000);
  }
});

test('budgets Antigravity Orchestrator by the planner and Hydrogen executor', () => {
  assert.equal(budget('antigravity', 'gemini-pro-orchestrator'), 1_000_000);
  assert.equal(budget('antigravity', 'gemini-pro-orchestrator-argon'), 1_000_000);
  assert.equal(budget('antigravity', 'gemini-pro-orchestrator-neon'), 512_000);
  assert.equal(budget('antigravity', 'gemini-pro-orchestrator-preview'), 128_000);
});

test('keeps CLI defaults and unknown models conservative', () => {
  const windows = { codex: new Map([['gpt-6.2-sol', 500_000], ['default', 800_000]]) };
  assert.equal(budget('codex', 'gpt-6.2-sol', windows), 500_000);
  assert.equal(budget('codex', 'default', windows), 128_000);
  assert.equal(budget('grok', 'grok-4.7'), 128_000);
  assert.equal(budget('claude', 'claude-opus-5-5'), 1_000_000);
  assert.equal(budget('claude', 'claude-opus-5-5', { claudeOneMillionDisabled: true }), 200_000);
  assert.equal(budget('claude', 'opus'), 128_000);
});

test('CLI default aliases use their own discovered catalog minimum, not cached-only entries', () => {
  const rows = [
    { agent: 'codex', id: 'codex-default' },
    { agent: 'grok', id: 'grok-default' },
    { agent: 'antigravity', id: 'antigravity-default' },
    { agent: 'claude', id: 'claude-default' },
    { agent: 'codex', id: 'codex-gpt-6.2-sol' },
    { agent: 'grok', id: 'grok-grok-4.7' },
    { agent: 'antigravity', id: 'antigravity-gemini-4-neon' },
    { agent: 'codex', id: 'codex-gpt-6.2-astra' },
    { agent: 'antigravity', id: 'antigravity-gpt-oss-120b-medium' },
  ];
  const windows = {
    codex: new Map([['gpt-6.2-sol', 500_000], ['gpt-6.2-astra', 272_000], ['hidden', 64_000]]),
    grok: new Map([['grok-4.7', 256_000]]),
  };
  assert.deepEqual(catalogContextWindows(rows, windows), [
    272_000, 256_000, 131_072, 128_000, 500_000, 256_000, 512_000, 272_000, 131_072,
  ]);
  const unknown = { agent: 'grok', id: 'grok-unknown' };
  assert.deepEqual(catalogContextWindows([rows[1], rows[5], unknown], windows), [128_000, 256_000, 128_000]);
});

test('uses Codex fallbacks for known older models only when the CLI cache has no entry', () => {
  const windows = { codex: new Map([['gpt-6.1-terra', 272_000], ['gpt-6-luna', 128_000]]) };
  assert.equal(budget('codex', 'gpt-6.1-sol', windows), 500_000);
  assert.equal(budget('codex', 'gpt-6.1-terra'), 500_000);
  assert.equal(budget('codex', 'gpt-6.1-terra', windows), 272_000);
  assert.equal(budget('codex', 'gpt-6-sol', windows), 272_000);
  assert.equal(budget('codex', 'gpt-6-luna'), 272_000);
  assert.equal(budget('codex', 'gpt-6-luna', windows), 128_000);
  assert.equal(budget('codex', 'gpt-6.1-terra-preview', windows), 128_000);
});

test('reads exact window sizes from the local Grok Build catalog', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-grok-metadata-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'models_cache.json');
  assert.equal(grokContextWindows(home).size, 0);
  await writeFile(file, JSON.stringify({ models: {
    'grok-4.7': { info: { id: 'grok-4.7', context_window: 256_000 } },
    'grok-4.7-build-fast': { info: { id: 'grok-4.7-build-fast', context_window: 192_000 } },
    'grok-bad': { info: { id: 'grok-bad', context_window: '500000' } },
    'grok-mismatch': { info: { id: 'grok-other', context_window: 400_000 } },
  } }));
  const grok = grokContextWindows(home);
  assert.equal(grok.size, 2);
  assert.equal(budget('grok', 'grok-4.7', { grok }), 256_000);
  assert.equal(budget('grok', 'grok-4.7-build-fast', { grok }), 192_000);
  assert.equal(budget('grok', 'grok-bad', { grok }), 128_000);
  await writeFile(file, 'not JSON');
  assert.equal(grokContextWindows(home).size, 0);
});
