import { Type } from 'typebox';

export default function (pi) {
  pi.registerTool({
    name: 'lookup', label: 'Lookup', description: 'Return a fixture value',
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }) {
      if (query !== 'fixture') throw new Error('Unexpected fixture query');
      return { content: [{ type: 'text', text: 'PI_FIXTURE_42' }] };
    },
  });
}
