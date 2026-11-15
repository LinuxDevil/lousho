import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(output: Record<string, unknown>, over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ output, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}


describe('outputRules.validate', () => {
  it('flags a schema that is not an object schema', () => {
    for (const jsonSchema of ['x', 42, ['object'], { type: 'string' }, {}]) {
      const g = graphOf({ jsonSchema });
      expect(validateGraph(g)).toStrictEqual([
        error('output', 'The output schema must be an object schema', 'output.jsonSchema'),
      ]);
    }
  });

  it("flags a required entry that names no property", () => {
    const g = graphOf({
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b'],
      },
    });
    expect(validateGraph(g)).toStrictEqual([
      error('output', "'b' is required but not defined", 'output.jsonSchema.required'),
    ]);
  });
});
