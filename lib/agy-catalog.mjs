import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { modelRows } from './catalog.mjs';
import { launchAgent } from './launch.mjs';
import { parseAgyQuota } from './usage-display.mjs';

const exec = promisify(execFile);

export function parseAgyModels(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9.]*[-][a-z0-9._-]{1,94})(?:\t+| {2,})([^\r\n]+)$/i.exec(line.trim());
    if (!match) continue;
    const [, slug, label] = match;
    rows.push({ id: slug, name: label });
  }
  return modelRows(rows);
}

export async function listAgyCliModels({ file, args, env, cwd }, signal) {
  signal.throwIfAborted();
  const { stdout } = await exec(file, args, {
    cwd, env, signal, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8',
  });
  return parseAgyModels(stdout);
}

export async function readAgyQuota(root, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-cli-quota-'));
  try {
    signal.throwIfAborted();
    const launch = launchAgent(root, 'antigravity', dir, { quotaOnly: true });
    const { stdout } = await exec(launch.file, launch.args, {
      cwd: launch.cwd, env: launch.env, signal, timeout: 10000,
      maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
    });
    return parseAgyQuota(stdout) ?? 'Antigravity quota: not reported';
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    return 'Antigravity quota: not available';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
