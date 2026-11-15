import { describe, expect, it } from 'vitest';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, ToolRef } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(tools: ToolRef[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ tools }));
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

function warning(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'warning', message, fieldPath);
}

describe('toolRules.validate', () => {

  it.each([
    ['/abs/x.ts', 'tool:x'],
    ['../x.ts', 'tool:x'],
    ['a/../x.ts', 'tool:x'],
  ])('rejects the file path %j', (file, nodeId) => {
    const graph = graphOf([{ file }]);
    expect(validateGraph(graph)).toStrictEqual([
      error(nodeId, 'Use a .ts or .js file inside the agent folder', 'tools[0].file'),
    ]);
  });

  it('rejects an id outside the spec-id pattern', () => {
    const graph = graphOf([{ builtin: 'web_fetch', id: 'bad id!' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:bad id!', 'The node id can use letters, digits, dash or underscore', 'tools[0].id'),
    ]);
  });

  it.each([
    ['token', 'github'],
  ] as const)(
    'warns when the %s credential is a plain string',
    (key, integration) => {
      const graph = graphOf([{ integration, credentials: { [key]: 'literal' } }]);
      expect(validateGraph(graph)).toStrictEqual([
        warning(`tool:${integration}`, 'Store this credential as a secret', `tools[0].credentials.${key}`),
      ]);
    },
  );
});
