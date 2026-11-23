import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgyCliModels } from './agy-catalog.mjs';
import { fresh, modelRows } from './catalog.mjs';
import { listAgents, launchAgent } from './launch.mjs';
import { createAgentSession } from './session.mjs';

// Classify failures without surfacing untrusted stdout, prompts or credentials.
function discoveryFailure(error, source) {
  const text = String(error?.message ?? '');
  let reason = 'CLI or protocol error';
  if (!error || /empty catalog/i.test(text)) reason = 'no models returned';
  else if (error.name === 'TimeoutError' || /timed out|timeout/i.test(text)) reason = 'timed out';
  else if (/login|sign.in|unauthori[sz]ed|not authenticated|credential/i.test(text)) reason = 'check CLI sign-in';
  else if (/custom inference route|native.*routing|could not check settings/i.test(text)) reason = 'check CLI configuration';
  return `${source}: ${reason}`;
}

export function createModelDiscovery(root, lifetimeSignal) {
  const catalogAttempts = new Map();

  async function listSessionModels(agent, signal) {
    signal.throwIfAborted();
    const temporary = await mkdtemp(join(tmpdir(), 'pi-local-cli-'));
    let session;
    const abort = () => session?.close();
    try {
      signal?.throwIfAborted();
      const launch = launchAgent(root, agent, temporary, { gateway: true });
      session = createAgentSession(agent, launch, () => {}, { gateway: true });
      signal?.addEventListener('abort', abort, { once: true });
      await session.start();
      signal?.throwIfAborted();
      return await session.catalogModels();
    } finally {
      signal?.removeEventListener('abort', abort);
      session?.close();
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  }

  async function discover(id, signal) {
    const deadline = AbortSignal.any([signal, lifetimeSignal, AbortSignal.timeout(12500)].filter(Boolean));
    const primary = id === 'antigravity' ? AbortSignal.any([deadline, AbortSignal.timeout(7000)]) : deadline;
    const source = id === 'codex' ? 'app-server' : 'acp';
    let problem;
    try {
      const models = await listSessionModels(id, primary);
      primary.throwIfAborted();
      const rows = modelRows(models);
      if (id !== 'antigravity' || rows.length) return { source, checkedAt: Date.now(), models: rows };
      problem = discoveryFailure(undefined, source);
    } catch (error) {
      signal?.throwIfAborted();
      lifetimeSignal.throwIfAborted();
      problem = discoveryFailure(primary.aborted ? primary.reason : error, source);
      if (id !== 'antigravity') throw new Error(problem);
    }
    let temporary;
    try {
      deadline.throwIfAborted();
      temporary = await mkdtemp(join(tmpdir(), 'pi-local-cli-catalog-'));
      const launch = launchAgent(root, id, temporary, { catalogOnly: true });
      const models = await listAgyCliModels(launch, deadline);
      deadline.throwIfAborted();
      if (!models.length) throw new Error('empty catalog');
      return { source: 'agy-models', checkedAt: Date.now(), models, advisory: problem };
    } catch (error) {
      signal?.throwIfAborted();
      lifetimeSignal.throwIfAborted();
      throw new Error(`${problem}; ${discoveryFailure(deadline.aborted ? deadline.reason : error, 'agy models')}`);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  }

  function localModels() {
    return listAgents(root).filter(({ available }) => available);
  }

  async function refreshCatalog(previous, signal, force = false) {
    const next = { ...previous };
    let changed = false;
    await Promise.all(localModels().map(async ({ id }) => {
      if (!force && fresh(previous[id])) return;
      try {
        const { advisory, ...row } = await discover(id, signal);
        next[id] = row;
        catalogAttempts.set(id, { note: advisory, at: row.checkedAt });
        changed = true;
      } catch (error) {
        signal?.throwIfAborted();
        lifetimeSignal.throwIfAborted();
        catalogAttempts.set(id, { note: error.message, at: Date.now() });
        // Keep the last known list for this CLI on launch or protocol errors.
      }
    }));
    signal?.throwIfAborted();
    return { next, changed };
  }

  return { localModels, refreshCatalog, catalogAttempt: agent => catalogAttempts.get(agent) };
}
