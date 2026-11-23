import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

let sessionId;
let bridge;
let resumed = false;
const rejectResume = process.argv.includes('reject-resume');
const isGateway = process.argv.includes('acp');
if (!isGateway) process.exit(2);

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const modelConfig = [{ id: 'model', category: 'model', currentValue: 'fixture', options: [{ value: 'fixture' }] }];
const message = text => send({ method: 'session/update', params: { sessionId, update: {
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
} } });

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } }); break;
    case 'session/new':
      sessionId = randomUUID();
      bridge = params.mcpServers[0]?.env.find(row => row.name === 'PI_LOCAL_CLI_MCP')?.value;
      reply(id, { sessionId, configOptions: modelConfig }); break;
    case 'session/resume':
      if (rejectResume) {
        send({ id, error: { code: -32000, message: 'fixture refuses resume' } });
        break;
      }
      sessionId = params.sessionId;
      bridge = params.mcpServers[0]?.env.find(row => row.name === 'PI_LOCAL_CLI_MCP')?.value;
      resumed = true;
      // ACP can emit old history during setup; this must not leak into the reply.
      message('fixture old history');
      reply(id, { sessionId, configOptions: modelConfig }); break;
    case 'session/close': reply(id, {}); break;
    case 'session/prompt': {
      const prompt = params.prompt[0].text;
      if (bridge && prompt.includes('fixture tool')) {
        const response = await fetch(bridge, { method: 'POST', body: JSON.stringify({
          method: 'tools/call', params: { name: 'lookup', arguments: { query: 'fixture' } },
        }) });
        if (!response.ok) throw new Error('fixture tool bridge closed');
        const result = (await response.json()).result.content[0].text;
        message(resumed ? `fixture resumed: ${result}` : result);
      } else if (resumed) {
        message(prompt.includes('private previous input') || prompt.includes('first response') ? 'unexpected replay' : 'resumed delta only');
      } else {
        message('first response');
      }
      reply(id, { stopReason: 'end_turn' }); break;
    }
    default: send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
}
