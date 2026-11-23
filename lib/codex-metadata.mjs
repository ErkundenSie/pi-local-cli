import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const maxBytes = 8 * 1024 * 1024;
let previous;

export function codexContextWindows(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (!isAbsolute(home)) return new Map();
  const file = join(home, 'models_cache.json');
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return new Map();
    const revision = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (previous?.file === file && previous.revision === revision) return previous.windows;
    const catalog = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const windows = new Map();
    for (const row of Array.isArray(catalog?.models) ? catalog.models : []) {
      if (typeof row?.slug !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(row.slug)) continue;
      if (!Number.isSafeInteger(row.context_window) || row.context_window <= 0) continue;
      const slug = row.slug.replace(/^(?:openai|codex)\//i, '');
      if (slug.includes('/')) continue;
      // max_context_window is a higher optional ceiling, not the default window.
      windows.set(slug, row.context_window);
    }
    previous = { file, revision, windows };
    return windows;
  } catch {
    return new Map();
  }
}
