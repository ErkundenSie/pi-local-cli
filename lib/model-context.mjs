import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { effortValues } from './chat-wire.mjs';

const fallback = 128_000;
const maxCacheBytes = 8 * 1024 * 1024;
let previousGrokCache;

// Fallback budgets for models offered by the CLI but absent from its local cache.
// Sol's 500K default is documented by OpenAI; the others match Pi's openai-codex catalog.
const codexFallbackWindows = new Map([
  ['gpt-6.1-sol', 500_000],
  ['gpt-6.1-terra', 500_000],
  ['gpt-6-sol', 272_000],
  ['gpt-6-luna', 272_000],
]);

// These are Pi's budgets for explicit models, not changes to the CLI's limits.
const antigravityWindows = new Map([
  // Prefer Antigravity's published 512K limit over the larger local display.
  ['gemini-4-neon', 512_000],
  ['gemini-4-carbon', 1_000_000],
  ['gemini-4-argon', 1_000_000],
  ['gemini-4-hydrogen', 1_000_000],
  ['gemini-3.8-flash', 1_000_000],
  ['claude-opus-5-5', 1_000_000],
  ['claude-sonnet-5-5', 1_000_000],
  ['gpt-oss-120b', 131_072],
]);
const claudeOneMillion = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

export function grokContextWindows(home = process.env.GROK_HOME || join(homedir(), '.grok')) {
  if (!isAbsolute(home)) return new Map();
  const file = join(home, 'models_cache.json');
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > maxCacheBytes) return new Map();
    const revision = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (previousGrokCache?.file === file && previousGrokCache.revision === revision) return previousGrokCache.windows;
    const { models } = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const windows = new Map();
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      for (const [id, row] of Object.entries(models)) {
        const size = row?.info?.context_window;
        if (/^[a-zA-Z0-9._-]{1,96}$/.test(id) && row?.info?.id === id && Number.isSafeInteger(size) && size > 0) {
          windows.set(id, size);
        }
      }
    }
    previousGrokCache = { file, revision, windows };
    return windows;
  } catch {
    return new Map();
  }
}

export function modelContextWindow({ agent, id }, { codex, grok, claudeOneMillionDisabled = false } = {}) {
  const prefix = `${agent}-`;
  if (!id.startsWith(prefix)) return fallback;
  const nativeId = id.slice(prefix.length);
  if (nativeId === 'default') return fallback;

  if (agent === 'codex') return codex?.get(nativeId) ?? codexFallbackWindows.get(nativeId) ?? fallback;
  if (agent === 'grok') return grok?.get(nativeId) ?? fallback;
  if (agent === 'antigravity') {
    const separator = nativeId.lastIndexOf('-');
    const family = effortValues.has(nativeId.slice(separator + 1)) ? nativeId.slice(0, separator) : nativeId;
    return antigravityWindows.get(family) ?? fallback;
  }
  if (agent === 'claude' && claudeOneMillion.has(nativeId)) return claudeOneMillionDisabled ? 200_000 : 1_000_000;
  return fallback;
}
