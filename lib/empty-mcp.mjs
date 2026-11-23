// A stand-in MCP server for a user's own servers during a gateway turn: it
// answers the handshake and offers no tools, so the CLI sees a healthy but
// empty server instead of the user's real one.
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  const { id, method, params } = message;
  if (typeof method !== 'string') continue;
  if (method === 'initialize') {
    send({ id, result: {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'local-cli-disabled', version: '0.3.0' },
    } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [] } });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
}
