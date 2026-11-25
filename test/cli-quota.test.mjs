import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCliQuotas } from '../lib/cli-quota.mjs';

async function quotaFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-quota-test-'));
  const remove = fs.rm;
  t.after(() => remove(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
  const config = join(root, '.local-agents.json');
  const previous = process.env.PI_LOCAL_CLI_CONFIG;
  process.env.PI_LOCAL_CLI_CONFIG = config;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_LOCAL_CLI_CONFIG;
    else process.env.PI_LOCAL_CLI_CONFIG = previous;
  });
  await fs.writeFile(config, JSON.stringify({ executables: {
    codex: { path: process.execPath, args: [fixture, 'codex'] },
    antigravity: { path: process.execPath, args: [fixture, 'antigravity'] },
    claude: join(root, 'missing-claude.exe'),
    grok: { path: process.execPath, args: [fixture, 'grok'] },
  } }));
  return root;
}

test('locked quota directories do not discard successful CLI results', async (t) => {
  const root = await quotaFixture(t);
  const remove = fs.rm;
  const cleanup = [];
  t.after(() => Promise.all(cleanup.map(({ dir }) => remove(dir, { recursive: true, force: true, maxRetries: 5 }))));
  t.mock.method(fs, 'rm', async (dir, options) => {
    if (!basename(dir).startsWith('pi-local-cli-quota-')) return remove(dir, options);
    cleanup.push({ dir, options });
    throw Object.assign(new Error('fixture: directory is still locked'), { code: 'EBUSY' });
  });
  const quotas = await readCliQuotas(root, ['codex', 'claude', 'antigravity', 'unknown'], AbortSignal.timeout(12000));
  assert.deepEqual(quotas, ['Codex 5h: 80% left', 'Claude quota: not available', 'Antigravity Gemini · 5h: 75% left']);
  assert.equal(cleanup.length, 2);
  for (const { options } of cleanup) {
    assert.ok(options.recursive && options.force && options.maxRetries > 0 && options.retryDelay > 0);
  }
});

test('Grok falls back to ACP billing and reports a fresh weekly quota', async (t) => {
  const root = await quotaFixture(t);
  const [quota] = await readCliQuotas(root, ['grok'], AbortSignal.timeout(12000));
  assert.match(quota, /^Grok weekly: 100% left, resets /);
});

test('an unavailable probe does not reject the quota summary', async () => {
  const quotas = await readCliQuotas(tmpdir(), ['codex', 'antigravity'], AbortSignal.abort());
  assert.deepEqual(quotas, ['Codex quota: not available', 'Antigravity quota: not available']);
});
