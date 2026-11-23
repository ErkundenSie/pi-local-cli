import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelRows } from './catalog.mjs';

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
