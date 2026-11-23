import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { baseURL, createBackend } from '../lib/provider.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repeat = Number(process.argv[2] ?? 3);
if (!Number.isSafeInteger(repeat) || repeat < 2 || repeat > 5) throw new Error('Expected 2–5 warm turns per mode (each uses local agy quota).');
const state = await mkdtemp(join(tmpdir(), 'pi-local-agy-bench-'));
const backends = {
  hot: createBackend(root),
  checkpoint: createBackend(root, { checkpointDir: state }),
};
const history = { hot: [], checkpoint: [] };
const samples = { hot: [], checkpoint: [] };
const coldResume = process.argv.includes('--cold-resume');

async function run(mode, index) {
  if (mode === 'checkpoint' && index && coldResume) {
    await backends[mode].stop();
    backends[mode] = createBackend(root, { checkpointDir: state });
  }
  const backend = backends[mode];
  const messages = history[mode];
  messages.push({ role: 'user', content: `Performance sample ${index + 1}. Reply only OK. Do not use tools.` });
  const start = performance.now();
  const deadline = AbortSignal.timeout(45_000);
  const response = await backend.fetch(baseURL + '/chat/completions', {
    method: 'POST', signal: deadline, body: JSON.stringify({ model: 'antigravity-default', messages, stream: true }),
  }, { caller: `benchmark-${mode}` });
  if (!response.ok) throw new Error(await response.text());
  let buffer = '';
  let answer = '';
  let first;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const text = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
      if (text) { first ??= performance.now() - start; answer += text; }
    }
  }
  if (!answer.trim()) throw new Error('Empty benchmark reply');
  const status = backend.turnStatus(`benchmark-${mode}`);
  const restored = status?.phase === 'done' && /restored/.test(status.detail);
  if (mode === 'checkpoint' && index && restored !== coldResume) throw new Error('Expected native reuse mode did not occur');
  if (mode === 'checkpoint' && index && !coldResume && !/reused/.test(status?.detail ?? '')) throw new Error('Checkpointed process was not reused');
  messages.push({ role: 'assistant', content: answer });
  const sample = { mode, turn: index + 1, firstTextMs: Math.round(first), totalMs: Math.round(performance.now() - start), restored };
  samples[mode].push(sample);
  console.log(JSON.stringify(sample));
}

const median = values => {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
try {
  for (let i = 0; i <= repeat; i++) {
    for (const mode of i % 2 ? ['checkpoint', 'hot'] : ['hot', 'checkpoint']) await run(mode, i);
  }
  console.table(Object.entries(samples).map(([mode, rows]) => ({ mode, warmSamples: repeat,
    medianFirstTextMs: median(rows.slice(1).map(row => row.firstTextMs)),
    medianTotalMs: median(rows.slice(1).map(row => row.totalMs)),
  })));
} finally {
  await Promise.all(Object.values(backends).map(backend => backend.stop()));
  await rm(state, { recursive: true, force: true, maxRetries: 5 });
}
