import { describe, expect, it } from 'vitest';
import { connectNodes } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, PermissionNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(permissions: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ permissions, ...over }));
}

function problem(
  nodeId: string,
  severity: 'error' | 'warning',
  message: string,
  fieldPath: string,
): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

function warning(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'warning', message, fieldPath);
}

const item = (graph: Graph, id: string) =>
  (graph.nodes.find((n) => n.id === id)!.data as PermissionNodeData).item;

describe('connectNodes: tool → permission', () => {

  it('refuses when a pattern already covers the tool', () => {
    const g = graphOf(
      [{ id: 'p2', tool: ['http', 'web-fetch'], action: 'deny' }],
      { tools: [{ builtin: 'http' }, { builtin: 'web-fetch' }] },
    );
    expect(connectNodes(g, 'tool:web-fetch', 'perm:p2')).toStrictEqual({
      ok: false,
      reason: 'This rule already covers web-fetch',
    });
  });

  it('refuses a permission owned by a different agent', () => {
    const g = specToGraph(
      specOf({
        tools: [{ builtin: 'http' }],
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              permissions: [{ id: 'p1', tool: 'http', action: 'ask' }],
            },
          },
        },
      }),
    );
    expect(connectNodes(g, 'tool:http', 'sub:r/perm:p1')).toStrictEqual({
      ok: false,
      reason: 'A rule only governs tools of the same agent',
    });
  });
});

describe('connectNodes: mcp → permission', () => {
  it('appends the <key>__* pattern', () => {
    const g = graphOf([{ id: 'p1', tool: 'http', action: 'ask' }], {
      mcpServers: { github: { command: 'npx' } },
    });
    const result = connectNodes(g, 'mcp:github', 'perm:p1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(item(result.graph, 'perm:p1').tool).toStrictEqual(['http', 'github__*']);
  });
});

describe('permissionRules.validate', () => {

  it.each(['lt',] as const)('requires a number for %s', (op) => {
    const g = graphOf([
      { id: 'p1', tool: 'http', when: { retries: { [op]: 'many' } }, action: 'deny' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('perm:p1', `Use a number for ${op}`, 'permissions[0].when.retries'),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it('requires matches to compile', () => {
    const g = graphOf([
      { id: 'p1', tool: 'http', when: { url: { matches: '[' } }, action: 'deny' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error(
        'perm:p1',
        'The pattern for url is not a valid regular expression',
        'permissions[0].when.url',
      ),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it.each([ 'deny'] as const)('warns on ttlMs with action %s', (action) => {
    const g = graphOf([{ id: 'p1', tool: '*', action, ttlMs: 60000 }], {
      tools: [{ builtin: 'http' }],
    });
    expect(validateGraph(g)).toStrictEqual([
      warning(
        'perm:p1',
        'Remembering only applies to ask and model-decided rules',
        'permissions[0].ttlMs',
      ),
    ]);
  });
});
