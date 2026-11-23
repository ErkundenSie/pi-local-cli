// stdio MCP server that exposes the tools a Magpie gateway caller declared.
//
// The local CLI (Codex, Claude Code, Antigravity, ...) spawns this file as an MCP
// server. Every tools/list and tools/call request is forwarded over loopback
// HTTP to the Magpie plugin, which parks the CLI turn until the caller answers
// with the matching tool result. This process only translates newline-delimited
// JSON-RPC on stdio to that endpoint and back. stdout carries protocol lines
// and nothing else: all diagnostics go to stderr.

import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

const ENDPOINT_VAR = 'PI_LOCAL_CLI_MCP';
const SERVER_NAME = 'pi-local-cli-tools';
const SERVER_VERSION = '0.3.0';
const LATEST_PROTOCOL = '2025-06-18';
const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
// A tools/list response is small; a tools/call result is bounded by the caller.
// The cap only protects this process from a runaway body, never times a call out.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

class BridgeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function log(message) {
  try {
    process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  } catch {
    // stderr is gone too; there is nowhere left to report anything.
  }
}

function shortMessage(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return text.replace(/\s+/g, ' ').slice(0, 2000);
}

// The endpoint is supplied only through the environment, never through argv,
// so a CLI's tool configuration cannot be tricked into forwarding credentials
// somewhere else. Only plain loopback HTTP is accepted.
function readEndpoint() {
  const raw = process.env[ENDPOINT_VAR];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value.startsWith('http://127.0.0.1:')) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (!url.pathname.startsWith('/mcp/') || url.pathname.length <= '/mcp/'.length) return undefined;
  return url;
}

function postJson(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    let request;
    try {
      request = httpRequest({
        protocol: 'http:',
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        // A one-shot connection: a parked tool call may last for minutes, and
        // no keep-alive socket should outlive the request either way.
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          accept: 'application/json',
          connection: 'close',
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        let failed = false;
        response.on('data', (chunk) => {
          if (failed) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            failed = true;
            response.destroy();
            reject(new Error('The Magpie tool bridge response was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (failed) return;
          resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        response.on('error', (error) => {
          if (!failed) reject(error);
        });
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', reject);
    // No timeout: the plugin parks the request until the gateway caller sends
    // the tool result, which may legitimately take many minutes.
    request.end(body);
  });
}

async function bridged(endpoint, payload) {
  let response;
  try {
    response = await postJson(endpoint, payload);
  } catch (error) {
    throw new BridgeFailure(-32000, `The Magpie tool bridge could not be reached (${shortMessage(error?.message, 'network error')}).`);
  }
  let parsed;
  try {
    parsed = response.text.trim() ? JSON.parse(response.text) : undefined;
  } catch {
    parsed = undefined;
  }
  const errorBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.error : undefined;

  if (response.status < 200 || response.status >= 300) {
    if (errorBody && Number.isInteger(errorBody.code) && typeof errorBody.message === 'string') {
      throw new BridgeFailure(errorBody.code, shortMessage(errorBody.message, `HTTP ${response.status}`));
    }
    throw new BridgeFailure(-32603, `The Magpie tool bridge returned HTTP ${response.status}.`);
  }
  if (errorBody) {
    const code = Number.isInteger(errorBody.code) ? errorBody.code : -32603;
    throw new BridgeFailure(code, shortMessage(errorBody.message, 'The Magpie tool bridge rejected the request.'));
  }
  if (!parsed || typeof parsed !== 'object' || !('result' in parsed)) {
    throw new BridgeFailure(-32603, 'The Magpie tool bridge returned an invalid response.');
  }
  return parsed.result;
}

function isParamsObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function initializeResult(params) {
  if (params !== undefined && !isParamsObject(params)) {
    throw new BridgeFailure(-32602, 'initialize params must be an object.');
  }
  const requested = params?.protocolVersion;
  const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.has(requested)
    ? requested
    : LATEST_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function toolCallParams(params) {
  if (!isParamsObject(params)) throw new BridgeFailure(-32602, 'tools/call params must be an object.');
  const name = params.name;
  const args = params.arguments;
  if (typeof name !== 'string' || !name.trim()) throw new BridgeFailure(-32602, 'tools/call requires a tool name.');
  if (args !== undefined && !isParamsObject(args)) throw new BridgeFailure(-32602, 'tools/call arguments must be an object.');
  return { name, arguments: args ?? {} };
}

const openWrites = new Set();
let finishing = false;

function writeMessage(message) {
  const line = `${JSON.stringify(message)}\n`;
  let settle;
  const written = new Promise((resolve) => { settle = resolve; });
  openWrites.add(written);
  const done = () => {
    openWrites.delete(written);
    settle();
  };
  try {
    process.stdout.write(line, done);
  } catch {
    // A closed stdout must not take the process down; the write simply never
    // reached the client.
    done();
  }
  return written;
}

function resultFor(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorFor(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleLine(endpoint, line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    // Never echo malformed input back onto stdout; stderr is the only place a
    // diagnostic may appear. The offending line is truncated, not repeated in full.
    const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
    log(`ignored invalid JSON input (${shortMessage(error?.message, 'parse error')}): ${snippet}`.trimEnd());
    return;
  }

  if (Array.isArray(message)) {
    // MCP over stdio does not use batches; answer the invalid request anyway.
    await writeMessage(errorFor(null, -32600, 'Invalid Request'));
    return;
  }
  if (message === null || typeof message !== 'object') {
    log('ignored a JSON-RPC message that is not an object.');
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = message.id;

  if (typeof message.method !== 'string') {
    // A response or malformed message. Only a request with an id can be answered.
    if (hasId) await writeMessage(errorFor(id, -32600, 'Invalid Request'));
    return;
  }

  const method = message.method;
  // Notifications (notifications/initialized, cancelled, progress, ...) must
  // not be answered, and `initialized` is always one of them.
  if (!hasId || method === 'notifications/initialized') return;

  try {
    let result;
    switch (method) {
      case 'initialize':
        result = initializeResult(message.params);
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = await bridged(endpoint, { method: 'tools/list' });
        break;
      case 'tools/call':
        result = await bridged(endpoint, { method: 'tools/call', params: toolCallParams(message.params) });
        break;
      default:
        throw new BridgeFailure(-32601, 'Method not found');
    }
    await writeMessage(resultFor(id, result));
  } catch (error) {
    const known = error instanceof BridgeFailure && Number.isInteger(error.code);
    if (!known) log(`failed the ${method} request: ${shortMessage(error?.message, 'internal error')}`);
    // Bridge failures carry a message that is safe to surface; anything else
    // is reduced to a generic sentence.
    await writeMessage(errorFor(
      id,
      known ? error.code : -32603,
      known ? error.message : 'The Magpie tool bridge failed the request.',
    ));
  }
}

async function finish() {
  if (finishing) return;
  finishing = true;
  // In-flight writes are flushed before the exit; a stuck pipe is abandoned
  // after a short grace period so the CLI is never left waiting on us.
  const guard = setTimeout(() => process.exit(0), 5000);
  try {
    await Promise.allSettled([...openWrites]);
  } finally {
    clearTimeout(guard);
  }
  process.exit(0);
}

const endpoint = readEndpoint();
if (!endpoint) {
  log(`${ENDPOINT_VAR} must be an absolute http://127.0.0.1:<port>/mcp/<token> URL.`);
  process.exit(1);
}

process.stdout.on('error', (error) => log(`stdout closed (${shortMessage(error?.message, 'write failed')}).`));
process.stdin.on('error', (error) => log(`stdin failed (${shortMessage(error?.message, 'read failed')}).`));
process.on('unhandledRejection', (reason) => {
  log(`ignored an unhandled rejection (${shortMessage(reason?.message ?? String(reason), 'unknown')}).`);
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on('line', (line) => {
  // Each line is handled independently: a parked tool call never blocks a
  // later request from being answered.
  void handleLine(endpoint, line);
});
lines.on('close', () => {
  void finish();
});
