import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(hooks: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ hooks, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}


describe('hookRules.validate', () => {
  it.each([ '../h.ts',])(
    'flags file %j',
    (file) => {
      const g = graphOf([{ id: 'h1', file }]);
      expect(validateGraph(g)).toStrictEqual([
        error('hook:h1', 'Use a .ts or .js file inside the agent folder', 'hooks[0].file'),
      ]);
    },
  );

  it('flags an inline hook with an empty name', () => {
    const g = graphOf([
      { id: 'h1', inline: { name: '  ', point: 'preToolCall', code: 'return ctx;' } },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('hook:h1', 'The hook needs a name', 'hooks[0].inline.name'),
    ]);
  });
});
