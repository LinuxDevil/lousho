import { describe, expect, it } from 'vitest';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, McpNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(mcpServers: Record<string, unknown>): Graph {
  return specToGraph(specOf({ mcpServers }));
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

describe('mcpRules.validate', () => {

  it('rejects oauth.clientSecret without oauth.clientId', () => {
    const graph = graphOf({
      linear: {
        url: 'https://mcp.linear.app/sse',
        oauth: { redirectUri: 'https://app.example.com/cb', clientSecret: { secret: 'lin-secret' } },
      },
    });
    expect(validateGraph(graph)).toStrictEqual([
      error(
        'mcp:linear',
        'Set the client id before the client secret',
        'mcpServers.linear.oauth.clientSecret',
      ),
    ]);
  });

  it('warns when an env value under a secret-sounding key is a plain string', () => {
    const graph = graphOf({ fs: { command: 'x', env: { GITHUB_TOKEN: 'literal', PLAIN: 'ok' } } });
    expect(validateGraph(graph)).toStrictEqual([
      warning('mcp:fs', 'Store this value as a secret', 'mcpServers.fs.env.GITHUB_TOKEN'),
    ]);
  });
});

describe('mcpRules.duplicateData', () => {
  it('rekeys the copy <key>-copy, then -copy-2', () => {
    const g = graphOf({ github: { command: 'npx' } });
    const first = duplicateNode(g, 'mcp:github');
    expect(first.nodeId).toBe('mcp:github-copy');
    const second = duplicateNode(first.graph, 'mcp:github');
    expect(second.nodeId).toBe('mcp:github-copy-2');
    const copy = first.graph.nodes.find((n) => n.id === 'mcp:github-copy')!;
    expect((copy.data as McpNodeData).item).toStrictEqual({ command: 'npx' });
  });
});
