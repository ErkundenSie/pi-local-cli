import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const windows = process.platform === 'win32';
const taskkill = windows && join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const frameLimit = 8 * 1024 * 1024;
const children = new Set();

function terminate(child, atExit = false) {
  if (!child.pid) return;
  if (!windows) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
    return;
  }
  const args = ['/PID', String(child.pid), '/T', '/F'];
  if (atExit) {
    spawnSync(taskkill, args, { stdio: 'ignore', windowsHide: true, timeout: 2000 });
  } else {
    const killer = spawn(taskkill, args, { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code) child.kill(); });
    killer.unref();
  }
}

export function displayError(message) {
  return String(message || 'The local CLI did not complete the request.').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(Bearer\s+)[\w.+~/-]+=*/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/([?&](?:token|key|code)=)[^\s&]+/gi, '$1[redacted]')
    .slice(0, 3600);
}

function rpcError(error) {
  const status = error?.data?.http_status;
  // Only surface recognized status codes, never the nested provider body:
  // it may contain URLs, credentials or request data.
  if (status === 402) {
    return Object.assign(new Error('The CLI reports HTTP 402: usage balance exhausted or payment required. Check the account quota and billing in the CLI.'),
      { status });
  }
  return new Error(displayError(error?.message));
}

export class Rpc {
  #child;
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #stderr = '';
  #requestId = 0;
  #requests = new Map();
  #closed = false;
  #exited;
  #markExited;

  constructor({ file, args, cwd, env }) {
    this.#exited = new Promise((resolve) => { this.#markExited = resolve; });
    this.#child = spawn(file, args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows, windowsHide: true,
    });
    children.add(this.#child);
    this.#child.stdout.on('data', (data) => this.#read(this.#decoder.write(data)));
    this.#child.stdout.on('end', () => this.#read(this.#decoder.end() + '\n'));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (data) => { this.#stderr = (this.#stderr + data).slice(-3600); });
    this.#child.on('error', (error) => this.close(`Could not start the CLI: ${error.message}`));
    this.#child.stdin.on('error', () => {}); // The exit event carries the diagnostic.
    const ended = (code, signal) => {
      children.delete(this.#child);
      const summary = `The CLI exited (${code ?? signal ?? 'unknown'}).`;
      this.#markExited();
      this.close(this.#stderr ? `${summary}\n${this.#stderr.trim()}` : summary, false);
    };
    // Some Bun/Windows children report exit before the stdin pipe closes.
    this.#child.on('exit', (code, signal) => setImmediate(() => ended(code, signal)));
    this.#child.on('close', ended);
  }

  get closed() { return this.#closed; }
  get exited() { return this.#exited; }

  #write(message) {
    if (this.#closed || !this.#child.stdin.writable) return false;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  request(method, params, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.#requestId;
      const timer = timeout === null ? undefined : setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`The CLI timed out during ${method}.`));
      }, timeout);
      this.#requests.set(id, { resolve, reject, timer });
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        this.#requests.delete(id);
        clearTimeout(timer);
        reject(new Error('The CLI connection has closed.'));
      }
    });
  }

  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, params });
  }

  #read(chunk) {
    if (this.#closed) return;
    this.#buffer += chunk;
    let newline;
    while (!this.#closed && (newline = this.#buffer.indexOf('\n')) !== -1) {
      if (newline > frameLimit) return this.close('The CLI sent an oversized protocol frame.');
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; } // Some CLIs emit startup banners.
      if (!message || typeof message !== 'object') continue;
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          void this.#answer(message);
        } else {
          try { this.onNotification?.(message.method, message.params ?? {}); }
          catch (error) { this.close(`Invalid CLI notification: ${error.message}`); }
        }
        continue;
      }
      const pending = this.#requests.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#requests.delete(message.id);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
    }
    if (this.#buffer.length > frameLimit) this.close('The CLI sent an oversized protocol frame.');
  }

  async #answer({ id, method, params }) {
    try {
      const result = await this.onRequest?.(method, params ?? {});
      if (result === undefined) {
        this.#write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client method' } });
      } else {
        this.#write({ jsonrpc: '2.0', id, result });
      }
    } catch {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Client could not handle the request' } });
    }
  }

  close(message = 'The CLI session was closed.', kill = true) {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(displayError(message));
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#requests.clear();
    if (kill) terminate(this.#child);
    this.#child.stdin.destroy();
    this.onClose?.(error);
  }
}

export function stopChildren() {
  for (const child of children) terminate(child, true);
}
