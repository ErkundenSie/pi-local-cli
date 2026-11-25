import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchAgent, quotaExecutable } from './launch.mjs';
import { Rpc } from './rpc.mjs';
import { readGrokLoginQuota } from './login-quota.mjs';
import { parseAgyQuota, parseClaudeQuota, parseCodexQuota, parseGrokBilling, parseGrokQuota } from './usage-display.mjs';

const exec = promisify(execFile);

async function withQuotaDirectory(signal, probe) {
  signal.throwIfAborted();
  const dir = await fs.mkdtemp(join(tmpdir(), 'pi-local-cli-quota-'));
  try {
    signal.throwIfAborted();
    return await probe(dir);
  } finally {
    // Windows can keep the CLI's working directory locked after process exit.
    // Retry briefly, but never replace a quota response with a cleanup error.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

async function run(file, args, signal) {
  return withQuotaDirectory(signal, async (cwd) => {
    const { stdout } = await exec(file, args, {
      cwd, signal, timeout: 12000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
    });
    return stdout;
  });
}

async function withQuotaRpc(root, id, signal, probe) {
  return withQuotaDirectory(signal, async (cwd) => {
    const rpc = new Rpc(launchAgent(root, id, cwd, { gateway: true }));
    const abort = () => rpc.close('The quota check was cancelled.');
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await probe(rpc);
    } finally {
      signal.removeEventListener('abort', abort);
      rpc.close();
      let timer;
      try {
        await Promise.race([rpc.exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

async function readCodexQuota(root, signal) {
  return withQuotaRpc(root, 'codex', signal, async (rpc) => {
    await rpc.request('initialize', { clientInfo: { name: 'pi-local-cli', version: '0.1.0' } }, 8000);
    rpc.notify('initialized');
    const result = await rpc.request('account/rateLimits/read', {}, 8000);
    return parseCodexQuota(result) ?? 'Codex quota: not reported';
  });
}

async function readClaudeQuota(root, signal) {
  const command = quotaExecutable(root, 'claude');
  if (!command) return 'Claude quota: not available';
  const stdout = await run(command.file, command.args, signal);
  const result = JSON.parse(stdout).result;
  return parseClaudeQuota(result) ?? 'Claude quota: not available';
}

async function readAgyQuota(root, signal) {
  return withQuotaDirectory(signal, async (dir) => {
    const launch = launchAgent(root, 'antigravity', dir, { quotaOnly: true });
    const { stdout } = await exec(launch.file, launch.args, {
      cwd: launch.cwd, env: launch.env, signal, timeout: 10000,
      maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
    });
    return parseAgyQuota(stdout) ?? 'Antigravity quota: not reported';
  });
}

async function readGrokAcpQuota(root, signal) {
  try {
    return await withQuotaRpc(root, 'grok', signal, async (rpc) => {
      await rpc.request('initialize', {
        protocolVersion: 1, clientInfo: { name: 'pi-local-cli', version: '0.1.0' }, clientCapabilities: {},
      }, 8000);
      return parseGrokBilling(await rpc.request('_x.ai/billing', {}, 8000)) ?? 'Grok quota: not reported';
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    return undefined;
  }
}

async function readGrokQuota(root, signal) {
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

const readers = {
  codex: ['Codex', readCodexQuota],
  claude: ['Claude', readClaudeQuota],
  grok: ['Grok', readGrokQuota],
  antigravity: ['Antigravity', readAgyQuota],
};

export async function readCliQuotas(root, ids, signal) {
  return Promise.all(ids.filter((id) => Object.hasOwn(readers, id)).map(async (id) => {
    const [name, read] = readers[id];
    try {
      return await read(root, signal);
    } catch {
      return `${name} quota: not available`;
    }
  }));
}
