import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callerToolOf } from '../lib/tool-bridge.mjs';

test('recognizes exact agy bridge aliases but not bare/native or foreign names', () => {
  const tools = ['lookup', 'mcp__a__b', 'read_file'].map(name => ({ function: { name } }));
  const ask = name => callerToolOf({ name, title: 'Run ' + name, rawInput: { name: 'lookup' } }, tools, { antigravity: true });
  assert.equal(ask('mcp_local_cli_tools_lookup'), 'lookup');
  assert.equal(ask('mcp_local_cli_tools_mcp_a_b'), 'mcp__a__b');
  for (const name of ['lookup', 'mcp_other_lookup', 'mcp_local_cli_tools_lookup_extra', 'read_file']) assert.equal(ask(name), null);
});
