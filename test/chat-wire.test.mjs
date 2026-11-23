import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatRequest, renderRequestPrompt, serveChat } from '../lib/chat-wire.mjs';

const jsonReply = '{"content":"literal","tool_calls":[{"name":"lookup","arguments":{"query":"x"}}]}';
const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
const messages = [{ role: 'user', content: 'Return some JSON' }];

for (const stream of [false, true]) {
  for (const tools of [[], [tool]]) {
    test(`ordinary JSON stays text with ${tools.length ? 'MCP tools declared' : 'no tools'} (${stream ? 'SSE' : 'JSON'})`, async () => {
      const request = parseChatRequest({ model: 'fixture', messages, tools, stream });
      assert.doesNotMatch(renderRequestPrompt(request), /raw JSON object of the form/);
      const response = await serveChat(request, async ({ emit }) => {
        emit(jsonReply);
        return { reason: 'end_turn' };
      });
      if (!stream) {
        const [choice] = (await response.json()).choices;
        assert.deepEqual(choice.message, { role: 'assistant', content: jsonReply });
        assert.equal(choice.finish_reason, 'stop');
      } else {
        const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]');
        const choices = frames.flatMap(frame => JSON.parse(frame.slice(6)).choices);
        assert.equal(choices.map(choice => choice.delta.content ?? '').join(''), jsonReply);
        assert.ok(choices.every(choice => !choice.delta.tool_calls));
        assert.equal(choices.at(-1).finish_reason, 'stop');
      }
    });
  }
}

test('only explicit validated bridge calls get a tool_calls finish reason', async () => {
  const request = parseChatRequest({ model: 'fixture', messages, tools: [tool] });
  await assert.rejects(serveChat(request, async () => ({ reason: 'tool_calls' })), /no validated tool calls/);
  await assert.rejects(serveChat(request, async () => ({ reason: 'tool_calls', toolCalls: [{ name: 'foreign', arguments: '{}' }] })),
    /invalid tool calls/);
  const response = await serveChat(request, async () => ({ reason: 'tool_calls', toolCalls: [
    { id: 'bridge-call', name: 'lookup', arguments: '{"query":"x"}' },
  ] }));
  const [choice] = (await response.json()).choices;
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(choice.message.tool_calls, [{ id: 'bridge-call', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } }]);
});
