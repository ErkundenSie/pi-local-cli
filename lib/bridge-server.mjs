import { createServer } from 'node:http';
import { ToolBridge } from './tool-bridge.mjs';

const maxBody = 1024 * 1024;

// Only the CLI's stdio MCP shim uses this ephemeral listener. The chat API
// is in-process and is never mounted on the listener.
export function createBridgeServer() {
  let port;
  let ready;
  let closed = false;
  const bridge = new ToolBridge({ getPort: () => port });
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
      else res.destroy();
    });
  });
  server.maxConnections = 64;

  async function handle(req, res) {
    const token = /^\/mcp\/([0-9a-f]{64})$/.exec(req.url ?? '')?.[1];
    if (!token || !bridge.hasSession(token)) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (Number(req.headers['content-length']) > maxBody) { res.writeHead(413).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    if (res.destroyed) return;
    const peer = new AbortController();
    const disconnect = () => { if (!res.writableFinished) peer.abort(); };
    res.once('close', disconnect);
    try {
      const response = await bridge.handle(new Request('http://127.0.0.1/', {
        method: 'POST', body: Buffer.concat(chunks), signal: peer.signal,
      }), token);
      const body = await response.text();
      if (res.destroyed) return;
      res.writeHead(response.status, { 'content-type': 'application/json', connection: 'close' });
      res.end(body);
    } finally {
      // The close listener also covers a socket lost while flushing the body.
      if (res.destroyed) disconnect();
    }
  }

  function start() {
    if (closed) return Promise.reject(new Error('The Local CLI bridge has stopped.'));
    return ready ??= new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off('listening', listening);
        ready = undefined;
        reject(error);
      };
      const listening = () => {
        server.off('error', failed);
        port = server.address().port;
        server.unref();
        resolve();
      };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen(0, '127.0.0.1');
    });
  }

  async function stop() {
    closed = true;
    await ready?.catch(() => {});
    if (!server.listening) return;
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await done;
  }
  return {
    bridge, start, stop,
    status: () => ({ listening: Boolean(server.listening), sessions: bridge.sessions, pending: bridge.pending }),
  };
}
