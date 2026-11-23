import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexContextWindows } from '../lib/codex-metadata.mjs';

test('reads the default window for the exact Codex model, not its optional maximum', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-codex-metadata-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(codexContextWindows(home).size, 0);
  const file = join(home, 'models_cache.json');
  await writeFile(file, JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', context_window: 500000, max_context_window: 872000 },
    { slug: 'openai/gpt-example', context_window: 170000 },
    { slug: 'other/gpt-other', context_window: 500000 },
    { slug: 'gpt-invalid', context_window: -1 },
  ] }));
  assert.deepEqual([...codexContextWindows(home)], [['gpt-6.2-sol', 500000], ['gpt-example', 170000]]);
  await writeFile(file, 'not JSON');
  assert.equal(codexContextWindows(home).size, 0);
});
