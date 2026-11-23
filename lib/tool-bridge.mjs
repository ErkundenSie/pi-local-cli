import { randomBytes, randomUUID } from 'node:crypto';
import { localToolCallId } from './turn-lifecycle.mjs';
import { fileURLToPath } from 'node:url';

const mcpServerPath = fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url));
const serverName = 'local_cli_tools';
// Grok's catalog key is `server__tool` and skips a name that already contains `__`.
const catalogLimit = 256;

export function catalogToolName(name, used) {
  let safe = String(name);
  while (safe.includes('__')) safe = safe.replaceAll('__', '_');
  safe = safe.replace(/[^A-Za-z0-9_-]/g, '_');
  while (safe.includes('__')) safe = safe.replaceAll('__', '_');
  safe = safe.replace(/^_+/, '');
  const max = catalogLimit - serverName.length - 2;
  if (safe.length > max) safe = safe.slice(0, max).replace(/_+$/, '');
  if (!safe) safe = 'tool';
  let candidate = safe;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `_${n++}`;
    const base = safe.slice(0, Math.max(1, max - suffix.length)).replace(/_+$/, '') || 'tool';
    candidate = `${base}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

// exposeTools gives each caller tool a Grok-safe MCP name and remembers the
// original, so a call comes back under the name the caller declared.
export function exposeTools(tools) {
  const used = new Set();
  const aliases = new Map();
  const listed = [];
  for (const tool of tools ?? []) {
    const definition = tool?.function;
    if (typeof definition?.name !== 'string' || !definition.name) continue;
    const name = catalogToolName(definition.name, used);
    aliases.set(name, definition.name);
    const description = definition.description ?? '';
    listed.push({
      name,
      description: name === definition.name ? description : `Known to the caller as ${definition.name}. ${description}`,
      inputSchema: definition.parameters ?? { type: 'object', properties: {} },
    });
  }
  return { listed, aliases };
}

// callerToolOf recognises an approval for one of the caller's tools. CLIs spell
// an MCP call as `mcp(server/tool)`, `server/tool`, `server__tool` or the bare
// catalog name. `use_tool` carries that name in its arguments.
export function callerToolOf(call, tools, { antigravity = false } = {}) {
  const { aliases } = exposeTools(tools);
  if (antigravity) {
    // The native ACP server reports `mcp_<server>_<tool>` in name.
    // Require an exact bridged alias, not a built-in title or raw arguments.
    const prefix = `mcp_${serverName}_`;
    return typeof call?.name === 'string' && call.name.startsWith(prefix)
      ? aliases.get(call.name.slice(prefix.length)) ?? null : null;
  }
  const texts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) texts.push(value.trim().replace(/\?$/, ''));
  };
  push(call?.name);
  push(call?.title);
  push(call?.toolName);
  const input = call?.rawInput;
  if (input && typeof input === 'object') {
    push(input.tool_name);
    push(input.toolName);
    push(input.name);
  } else {
    push(input);
  }
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const text of texts) {
    if (aliases.has(text)) return aliases.get(text);
    for (const [exposed, original] of aliases) {
      if (text === original) return original;
      const named = new RegExp(`(?:^|[\\s(])${escaped(serverName)}[\\\\/_.-]+(?:${escaped(exposed)}|${escaped(original)})(?:$|[)\\s])`, 'i');
      if (named.test(text)) return original;
    }
  }
  return null;
}

export function isCatalogSearch(call) {
  return [call?.name, call?.title, call?.toolName].some((value) => typeof value === 'string' && value.trim() === 'search_tool');
}

// ToolBridge turns the tools a gateway caller declared into MCP tools that the
// local CLI spawns and calls. A call parks the CLI turn until the caller's next
// request carries the result back under the same tool_call id.
export class ToolBridge {
  #getPort;
  #entries = new Map();
  #byCallId = new Map();

  constructor({ getPort }) {
    this.#getPort = getPort;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.#getPort()}/mcp`;
  }

  // attach registers a conversation's tools and returns the MCP server spec the
  // CLI is launched with. Nothing is spawned here: the CLI starts it.
  attach(tools) {
    if (!tools.length) return undefined;
    const token = randomBytes(32).toString('hex');
    const exposed = exposeTools(tools);
    const entry = {
      token,
      tools: exposed.listed,
      aliases: exposed.aliases,
      record: undefined,
      spec: {
        name: serverName,
        command: process.execPath,
        args: [mcpServerPath],
        env: { PI_LOCAL_CLI_MCP: `${this.endpoint}/${token}` },
      },
    };
    this.#entries.set(token, entry);
    return entry;
  }

  hasSession(token) {
    return this.#entries.has(token);
  }

  close(token) {
    this.#entries.delete(token);
    for (const [id, call] of this.#byCallId) {
      if (call.token !== token) continue;
      this.#byCallId.delete(id);
      call.reject(new Error('The local CLI turn was closed before its tool result arrived.'));
    }
  }

  // has tells whether a call is still waiting, so a request is not matched to a
  // conversation whose tool call already expired.
  has(callId) {
    return this.#byCallId.has(callId);
  }

  // answer hands a caller's tool result to the blocked MCP call, which lets the
  // CLI continue the turn it never left. content is the text the caller sent,
  // or { parts, images } when that result also carries inline images. The
  // images were already checked as data URLs; this only places them beside
  // the text of the same tool call.
  answer(callId, content, isError = false) {
    const call = this.#byCallId.get(callId);
    if (!call) return undefined;
    this.#byCallId.delete(callId);
    call.resolve({ content, isError });
    return true;
  }

  async #body(request) {
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw Object.assign(new Error('Body too large'), { code: -32600 });
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON body'), { code: -32600 }); }
  }

  // handle serves the endpoint the MCP executable talks to.
  async handle(request, token) {
    const entry = this.#entries.get(token);
    if (!entry) return Response.json({ error: { code: -32001, message: 'This tool session has ended.' } }, { status: 404 });
    if (request.method !== 'POST') return Response.json({ error: { code: -32600, message: 'POST required' } }, { status: 405 });
    let body;
    try { body = await this.#body(request); }
    catch (error) { return Response.json({ error: { code: error.code ?? -32600, message: error.message } }, { status: 400 }); }

    if (body?.method === 'tools/list') return Response.json({ result: { tools: entry.tools } });
    if (body?.method !== 'tools/call') return Response.json({ error: { code: -32601, message: 'Unsupported tool method' } }, { status: 400 });
    const name = body.params?.name;
    const args = body.params?.arguments;
    if (typeof name !== 'string' || !entry.tools.some((tool) => tool.name === name) ||
        (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))) {
      return Response.json({ error: { code: -32602, message: 'Unknown tool or invalid arguments' } }, { status: 400 });
    }

    if (request.signal.aborted || !this.#entries.has(token)) {
      return Response.json({ error: { code: -32001, message: 'This tool session has ended.' } }, { status: 404 });
    }
    const id = localToolCallId(randomUUID());
    const settled = Promise.withResolvers();
    this.#byCallId.set(id, { token, resolve: settled.resolve, reject: settled.reject });
    const disconnect = () => {
      this.#byCallId.delete(id);
      settled.reject(new Error('The CLI disconnected while waiting for its tool result.'));
      entry.record?.onToolDisconnect?.(id);
    };
    request.signal.addEventListener('abort', disconnect, { once: true });
    try {
      const original = entry.aliases.get(name) ?? name;
      entry.record?.onToolCall?.({ id, name: original, arguments: JSON.stringify(args ?? {}) });
      const outcome = await settled.promise;
      return Response.json({
        result: { content: toolResultBlocks(outcome.content), isError: Boolean(outcome.isError) },
      });
    } finally {
      this.#byCallId.delete(id);
      // Keep the signal subscribed until the HTTP response finishes, so a
      // disconnect mid-write cannot appear to be a successful delivery.
    }
  }
}

const imageMarker = /^\[image \d+: [0-9a-f]{6}\]$/;

// toolResultBlocks keeps a tool result's text and images in the order the
// caller sent them. A marker that stands in for an image in the transcript
// becomes the image itself here, so the CLI sees the picture with this call
// and not a later prompt. Anything that is not a validated image stays text.
function toolResultBlocks(content) {
  const images = Array.isArray(content?.images)
    ? content.images.filter((image) => typeof image?.data === 'string' && typeof image?.mimeType === 'string')
    : [];
  if (!images.length) return [{ type: 'text', text: String(content ?? '') }];
  const parts = Array.isArray(content.parts) ? content.parts : null;
  if (!parts) {
    const blocks = [];
    if (content.text) blocks.push({ type: 'text', text: String(content.text) });
    for (const image of images) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    return blocks;
  }
  let next = 0;
  const blocks = [];
  for (const part of parts) {
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.text === '') continue;
    if (imageMarker.test(part.text) && next < images.length) {
      const image = images[next++];
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    } else {
      blocks.push({ type: 'text', text: part.text });
    }
  }
  while (next < images.length) {
    const image = images[next++];
    blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}
