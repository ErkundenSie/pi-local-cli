import { effortValues } from './chat-wire.mjs';

const validId = /^[a-zA-Z0-9._-]{1,96}$/;
const maxAge = 5 * 60 * 1000;
const agentIds = ['codex', 'claude', 'antigravity', 'grok'];

export function modelRows(models) {
  const unique = new Map();
  if (!Array.isArray(models)) return [];
  for (const row of models.slice(0, 256)) {
    if (typeof row?.id !== 'string' || row.id === 'default' || !validId.test(row.id) || unique.has(row.id)) continue;
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 200) : '';
    const efforts = Array.isArray(row.efforts)
      ? [...effortValues].filter(level => row.efforts.includes(level))
      : [];
    unique.set(row.id, { id: row.id, name: name || row.id, efforts });
  }
  return [...unique.values()];
}

export function restoreCatalog(stored) {
  const raw = stored?.piLocalCliCatalog;
  const catalog = {};
  for (const id of agentIds) {
    const row = raw?.[id];
    if (Number.isSafeInteger(row?.checkedAt) && row.checkedAt >= 0 && row.checkedAt <= 8.64e15 && Array.isArray(row.models)) {
      catalog[id] = { checkedAt: row.checkedAt, models: modelRows(row.models),
        ...(row.source === 'agy-models' || row.source === 'acp' || row.source === 'app-server' ? { source: row.source } : {}),
      };
    }
  }
  return catalog;
}

export function fresh(row, now = Date.now()) {
  const age = now - row?.checkedAt;
  return age >= 0 && age < maxAge;
}

export function agyModelFamilies(models) {
  const nativeIds = new Set(models.map(({ id }) => id));
  const families = new Map();
  for (const model of models) {
    const separator = model.id.lastIndexOf('-');
    if (separator < 1) continue;
    const id = model.id.slice(0, separator);
    const effort = model.id.slice(separator + 1);
    if (!effortValues.has(effort) || nativeIds.has(id) || id === 'default') continue;
    if (!families.has(id)) families.set(id, new Map());
    families.get(id).set(effort, model);
  }
  for (const [id, variants] of families) {
    if (variants.size < 2) families.delete(id);
  }
  return families;
}

export function catalogModels(catalog) {
  return Object.entries(catalog).flatMap(([agent, { models }]) => {
    const entries = models.map(({ id, name, efforts }) => ({ id: `${agent}-${id}`, agent, name, efforts }));
    if (agent === 'antigravity') {
      for (const [id, variants] of agyModelFamilies(models)) {
        entries.push({ id: `${agent}-${id}`, agent, name: id, efforts: [...variants.keys()] });
      }
    }
    return entries;
  });
}
