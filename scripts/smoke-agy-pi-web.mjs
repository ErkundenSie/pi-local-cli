import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const webRoot = process.argv[2];
if (!webRoot || !isAbsolute(webRoot)) throw new Error('Usage: node scripts/smoke-agy-pi-web.mjs <absolute pi-web install path> [--live]');
const live = process.argv.includes('--live');
const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'pi-local-web-smoke-'));
const agentDir = join(sandbox, 'agent');
const cwd = join(sandbox, 'workspace');
const calls = join(sandbox, 'tool-calls.log');
const marker = `PI_LOOKUP_${randomUUID()}`;
const model = 'antigravity-default';
const { PI_WEB_PASSWORD, PI_OFFLINE, ...env } = process.env;

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function web(use) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webRoot, env: { ...env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir,
      PI_LOCAL_CLI_AGY_RESUME: '1', ...(live ? {} : { PI_LOCAL_CLI_CONFIG: join(sandbox, 'fixture.json') }), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const out of [child.stdout, child.stderr]) out.on('data', chunk => { logs = (logs + chunk).slice(-6500); });
  const closed = once(child, 'close');
  async function api(path, body, timeout = 15000) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeout),
      ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok || data?.success === false) throw new Error(`${path} ${response.status}: ${data.error ?? 'request failed'}`);
    return data;
  }
  try {
    for (let i = 0; ; i++) {
      assert.equal(child.exitCode, null, logs);
      try { await api('/api/auth/providers', undefined, 2500); break; }
      catch (error) { if (i === 55) throw error; await delay(250); }
    }
    return await use(api);
  } catch (error) {
    if (logs) console.error(logs);
    throw error;
  } finally {
    if (child.pid && child.exitCode === null && process.platform === 'win32') {
      // Match pi-web stop on Windows, including the native subprocesses.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    }
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

async function findSession(dir, id) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const match = entries.find(entry => entry.isFile() && entry.name.endsWith(`${id}.jsonl`));
  return match && join(match.parentPath, match.name);
}

async function waitForTurn(id, count) {
  const deadline = AbortSignal.timeout(75_000);
  while (!deadline.aborted) {
    const file = await findSession(join(agentDir, 'sessions'), id);
    if (file) {
      const entries = (await readFile(file, 'utf8')).trim().split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
      const replies = messages.filter(msg => msg.role === 'assistant' && ['stop', 'error', 'aborted'].includes(msg.stopReason));
      if (replies.length >= count) {
        const last = replies.at(-1);
        assert.equal(last.stopReason, 'stop', last.errorMessage);
        return { messages, last };
      }
    }
    await delay(150);
  }
  throw new Error('No completed assistant message before deadline');
}

async function nativeSessionId() {
  const dir = join(agentDir, 'local-cli', 'agy-checkpoints');
  const files = (await readdir(dir)).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(join(dir, files[0]), 'utf8')).sessionId;
}

try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const tool = join(agentDir, 'fixture-tool.mjs');
  await writeFile(tool, `import {appendFileSync} from 'node:fs';
import {Type} from 'typebox';
export default function(pi) { pi.registerTool({name:'lookup',label:'Lookup',description:'Return a random verification marker. Call once with query fixture.',parameters:Type.Object({query:Type.String()}),async execute(_id, {query}) {
  if (query !== 'fixture') throw new Error('Unexpected query');
  appendFileSync(${JSON.stringify(calls)}, 'call\\n');
  return {content:[{type:'text',text:${JSON.stringify(marker)}}]};
}}); }`);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [root], extensions: [tool] }));
  if (!live) await writeFile(join(sandbox, 'fixture.json'), JSON.stringify({ executables: {
    antigravity: { path: process.execPath, args: [join(root, 'test', 'fixture-resume.mjs')] },
  } }));
  // Use only this synthetic project and a harmless custom tool. No user configuration is changed.
  const { id, nativeId } = await web(async api => {
    const created = await api('/api/agent/new', { type: 'prompt', cwd, provider: 'local-cli', modelId: model,
      toolNames: ['read'], message: 'Reply OK only. Do not call tools.' });
    assert.ok(created.sessionId);
    await waitForTurn(created.sessionId, 1);
    return { id: created.sessionId, nativeId: await nativeSessionId() };
  });
  await web(async api => {
    await api(`/api/agent/${encodeURIComponent(id)}`, {
      type: 'prompt', toolNames: ['read'],
      message: live ? 'Call the registered lookup MCP tool exactly once with query fixture. Return the exact marker from that tool and nothing else.' : 'fixture tool',
    });
    const { messages, last } = await waitForTurn(id, 2);
    const toolCalls = messages.flatMap(msg => Array.isArray(msg.content) ? msg.content : []).filter(part => part.type === 'toolCall' && part.name === 'lookup');
    assert.equal(await nativeSessionId(), nativeId, 'The tool must run in the restored native session');
    assert.equal(toolCalls.length, 1, `Pi must dispatch exactly one lookup; final text: ${last.content.filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0, 600)}`);
    assert.equal((await readFile(calls, 'utf8')).trim(), 'call');
    assert.ok(last.content.some(part => part.type === 'text' && part.text.includes(marker)), 'CLI did not return the bridge result');
    if (!live) assert.ok(last.content.some(part => part.type === 'text' && part.text.includes('fixture resumed')));
  });
  console.log(`Pi Web restart → ${live ? 'real agy' : 'fixture ACP'} → new bridge → one Pi tool call → result returned`);
} finally {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
