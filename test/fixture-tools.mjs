// A stand-in for `codex app-server` that behaves like the real one where the
// gateway cares: it reads the `-c mcp_servers.<name>` flags Codex would use,
// spawns that MCP server itself, and calls the caller's tool through it.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parse as parseToml } from 'smol-toml';

process.on('unhandledRejection', (error) => console.error('fixture rejection', error?.stack ?? error));
let threads = 0;
let modelResponses = 0;

function sendUsage(omitLast = false) {
  modelResponses++;
  const counts = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5 };
  const total = Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, count * modelResponses]));
  send({ method: 'thread/tokenUsage/updated', params: {
    threadId: currentThread, turnId: 'tools-turn', tokenUsage: { total, ...(!omitLast && { last: counts }), modelContextWindow: 500_000 },
  } });
}
let currentThread = undefined;

const flags = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-c') continue;
  const assignment = args[++index] ?? '';
  const split = assignment.indexOf('=');
  if (split > 0) {
    let value = assignment.slice(split + 1);
    // Codex parses `-c` values as TOML; JSON covers the plain string and array
    // cases, and TOML covers inline tables such as an MCP server entry.
    try { value = JSON.parse(value); } catch { try { value = parseToml(`v = ${value}`).v; } catch { /* a bare string */ } }
    flags.set(assignment.slice(0, split), value);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function mcpSession(cwd, fault) {
  const prefix = 'mcp_servers.local_cli_tools';
  const inline = flags.get(prefix);
  const command = inline?.command ?? flags.get(`${prefix}.command`);
  const serverArgs = inline?.args ?? flags.get(`${prefix}.args`) ?? [];
  const env = { ...process.env, ...(inline?.env ?? flags.get(`${prefix}.env`) ?? {}) };
  if (!command) return null;
  const child = spawn(command, serverArgs, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const reader = createInterface({ input: child.stdout });
  const waiting = new Map();
  let next = 0;
  child.on('exit', () => {
    for (const pending of waiting.values()) pending.reject(new Error('fixture MCP exited'));
    waiting.clear();
  });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await call('tools/list', {});
    const tool = listed.tools[0];
    if (!tool) return { content: 'no tools' };
    const pending = call('tools/call', { name: tool.name, arguments: { query: 'fixture' } });
    if (fault === 'process') setTimeout(() => process.exit(19), 1100);
    if (fault === 'bridge') setTimeout(() => child.kill(), 1100);
    const result = await pending;
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const images = blocks.filter((block) => block.type === 'image').map((block) => block.mimeType);
    return { content: text, images, kinds: blocks.map((block) => block.type).join(',') };
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill(), 200).unref();
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  const { id, method, params } = message;
  if (method === undefined) continue;
  switch (method) {
    case 'initialize': send({ id, result: { userAgent: 'fixture' } }); break;
    case 'initialized': break;
    case 'config/read': send({ id, result: { config: {
      model_provider: 'openai', openai_base_url: '',
      // The real Codex would also list the injected server; the gateway only
      // checks that the user's own servers are off.
    } } }); break;
    case 'model/list': send({ id, result: { data: [{ model: 'test-model', displayName: 'Fixture' }] } }); break;
    case 'thread/start':
      if (params?.sandbox !== 'read-only' || params?.approvalPolicy !== 'never' || params?.ephemeral !== true) {
        send({ id, error: { code: -32602, message: 'fixture expected a read-only, approval-free, ephemeral Codex thread' } });
        break;
      }
      threads += 1;
      currentThread = `tools-thread-${process.pid}-${threads}`;
      send({ id, result: { thread: { id: currentThread }, model: params?.model ?? 'test-model', modelProvider: 'openai' } });
      break;
    case 'turn/start': {
      const prompt = params?.input?.[0]?.text ?? '';
      if (process.env.FIXTURE_LOG) {
        appendFileSync(process.env.FIXTURE_LOG, `${JSON.stringify({ thread: currentThread, prompt, model: params?.model, effort: params?.effort })}\n`);
      }
      send({ id, result: { turn: { id: 'tools-turn' } } });
      // A probe turn reports back the user-input item types it received.
      if (prompt.includes('probe')) {
        const items = (params?.input ?? []).map((item) => item.type === 'image'
          ? `image:${String(item.url).slice(0, 22)}` : item.type).join(',');
        send({ method: 'item/agentMessage/delta', params: { threadId: currentThread, turnId: 'tools-turn', delta: items } });
        send({ method: 'turn/completed', params: { threadId: currentThread, turn: { id: 'tools-turn', status: 'completed' } } });
        break;
      }
      const answered = prompt.includes('"role":"tool"');
      if (prompt.includes('rate limited')) {
        send({ method: 'turn/completed', params: { threadId: currentThread, turn: {
          id: 'tools-turn', status: 'failed', error: { message: "You've hit your usage limit. Try again later." },
        } } });
        break;
      }
      if (answered) {
        send({ method: 'item/agentMessage/delta', params: { threadId: currentThread, turnId: 'tools-turn', delta: 'done after tool' } });
      } else {
        send({ method: 'item/agentMessage/delta', params: { threadId: currentThread, turnId: 'tools-turn', delta: 'before tool' } });
        if (flags.has('mcp_servers.local_cli_tools')) sendUsage();
        const fault = prompt.includes('drop process') ? 'process' : prompt.includes('drop bridge') ? 'bridge' : undefined;
        let call;
        try { call = await mcpSession(params?.cwd ?? process.cwd(), fault); }
        catch {
          send({ method: 'turn/completed', params: { threadId: currentThread, turn: { id: 'tools-turn', status: 'failed', error: { message: 'fixture MCP closed' } } } });
          break;
        }
        const imageNote = call?.images?.length ? ` [${call.kinds}]` : '';
        send({ method: 'item/agentMessage/delta', params: { threadId: currentThread, turnId: 'tools-turn', delta: call ? `; tool said ${call.content}${imageNote}` : '; no tool server' } });
      }
      if (!prompt.includes('skip usage')) sendUsage(prompt.includes('only cumulative'));
      send({ method: 'turn/completed', params: { threadId: currentThread, turn: { id: 'tools-turn', status: 'completed' } } });
      break;
    }
    default: if (id !== undefined) send({ id, error: { code: -32601, message: `fixture does not serve ${method}` } });
  }
}
