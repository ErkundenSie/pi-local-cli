import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseGrokBilling } from './usage-display.mjs';

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 65536) throw new Error('The CLI login file is too large.');
  return JSON.parse(text);
}

function fresh(expiresAt) {
  if (expiresAt == null || expiresAt === '') return true;
  const numeric = Number(expiresAt);
  const expires = Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(expiresAt));
  if (!Number.isFinite(expires)) return true;
  return expires > Date.now() + 30_000;
}

async function vendorGet(url, token, signal, headers) {
  const response = await fetch(url, {
    signal, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
  });
  if (!response.ok) throw new Error('The quota service rejected the CLI login.');
  const text = await response.text();
  if (text.length > 65536) throw new Error('The quota response is too large.');
  return JSON.parse(text);
}

export async function readGrokLoginQuota(signal) {
  try {
    const file = join(process.env.GROK_HOME || join(homedir(), '.grok'), 'auth.json');
    const data = await readJson(file);
    const entry = Object.values(data ?? {}).find((item) => typeof item?.key === 'string');
    if (!entry || entry.key.length > 8192 || !fresh(entry.expires_at)) return 'Grok quota: not available';
    const billing = await vendorGet('https://cli-chat-proxy.grok.com/v1/billing?format=credits', entry.key, signal);
    return parseGrokBilling(billing) ?? 'Grok quota: not reported';
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    return 'Grok quota: not available';
  }
}
