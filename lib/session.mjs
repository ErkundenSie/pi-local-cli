import { AcpSession } from './session/acp.mjs';
import { CodexSession } from './session/codex.mjs';

// The backend only uses the shared session lifecycle; vendor RPC methods
// and capability checks stay inside the protocol adapters.
export function createAgentSession(agent, launch, emit, options) {
  return agent === 'codex'
    ? new CodexSession(launch, emit, options)
    : new AcpSession(agent, launch, emit, options);
}
