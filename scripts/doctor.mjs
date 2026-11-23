import { fileURLToPath } from 'node:url';
import { listAgents } from '../lib/launch.mjs';

const agents = listAgents(fileURLToPath(new URL('../', import.meta.url)));
for (const { label, available, hint } of agents) {
  console.log(available ? `[found] ${label} (sign-in not checked)` : `[missing] ${label} — ${hint}`);
}
if (!agents.some(({ available }) => available)) process.exitCode = 1;
