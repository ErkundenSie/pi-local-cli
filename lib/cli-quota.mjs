import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchAgent, quotaExecutable } from './launch.mjs';
import { Rpc } from './rpc.mjs';
import { readGrokLoginQuota } from './login-quota.mjs';
import { parseClaudeQuota, parseCodexQuota, parseGrokBilling, parseGrokQuota } from './usage-display.mjs';

const exec = promisify(execFile);

async function run(file, args, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-cli-quota-'));
  try {
    signal.throwIfAborted();
    const { stdout } = await exec(file, args, {
      cwd: dir, signal, timeout: 12000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readCodexQuota(root, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-cli-quota-'));
  const rpc = new Rpc(launchAgent(root, 'codex', dir, { gateway: true }));
  try {
    signal.throwIfAborted();
    await rpc.request('initialize', { clientInfo: { name: 'pi-local-cli', version: '0.1.0' } }, 8000);
    rpc.notify('initialized');
    const result = await rpc.request('account/rateLimits/read', {}, 8000);
    return parseCodexQuota(result) ?? 'Codex quota: not reported';
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    return 'Codex quota: not available';
  } finally {
    rpc.close();
    await Promise.race([rpc.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readClaudeQuota(root, signal) {
  const command = quotaExecutable(root, 'claude');
  if (!command) return 'Claude quota: not available';
  try {
    const stdout = await run(command.file, command.args, signal);
    const result = JSON.parse(stdout).result;
    if (typeof result === 'string' && !/not logged in|run \/login/i.test(result)) {
      const parsed = parseClaudeQuota(result);
      if (parsed) return parsed;
    }
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
  }
  return 'Claude quota: not available';
}

async function readGrokAcpQuota(root, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-cli-quota-'));
  const rpc = new Rpc(launchAgent(root, 'grok', dir, { gateway: true }));
  try {
    signal.throwIfAborted();
    await rpc.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'pi-local-cli', version: '0.1.0' }, clientCapabilities: {},
    }, 8000);
    return parseGrokBilling(await rpc.request('_x.ai/billing', {}, 8000)) ?? 'Grok quota: not reported';
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    return undefined;
  } finally {
    rpc.close();
    await Promise.race([rpc.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readGrokQuota(root, signal) {
  const command = quotaExecutable(root, 'grok');
  if (command) {
    try {
      const parsed = parseGrokQuota(await run(command.file, command.args, signal));
      if (parsed) return parsed;
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
    }
  }
  return await readGrokAcpQuota(root, signal) ?? readGrokLoginQuota(signal);
}

const readers = { codex: readCodexQuota, claude: readClaudeQuota, grok: readGrokQuota };

export async function readCliQuotas(root, ids, signal) {
  const lines = await Promise.all(ids.filter((id) => readers[id]).map((id) => readers[id](root, signal)));
  return lines.filter(Boolean);
}
