import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { AgentNodeData, Problem, SubagentNodeData } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: a ref, a remote and an inline subagent. */
const WORKED = `version: 2
name: support-triage
model: anthropic/claude-sonnet-5-5
instructions: Triage tickets.
subagents:
  billing: { ref: agents/billing.yaml }
  search:
    remote: { url: https://search.example.com, auth: { secret: search-token }, description: Web search agent }
  research:
    inline: { name: research, description: Looks things up, model: openai/gpt-5, instructions: Research., tools: [ { builtin: web-fetch } ] }
`;

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph(specOf(over));
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

describe('subagentRules.validate', () => {

  it.each([ 'http://agents.example.com/x'])(
    'rejects the remote url %j',
    (url) => {
      const graph = graphOf({
        subagents: { search: { remote: { url, description: 'd' } } },
      });
      expect(validateGraph(graph)).toStrictEqual([
        error('sub:search', 'The remote agent needs a full URL', 'subagents.search.remote.url'),
      ]);
    },
  );
});

describe('duplicate', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('gives a duplicated subagent a "<key>-copy" key', () => {
    const r = duplicateNode(graph, 'sub:billing');
    expect(r.nodeId).toBe('sub:billing-copy');
    const clone = r.graph.nodes.find((n) => n.id === r.nodeId);
    expect((clone?.data as SubagentNodeData).key).toBe('billing-copy');
    expect((clone?.data as SubagentNodeData).item).toStrictEqual({ ref: 'agents/billing.yaml' });
  });

  it('gives a duplicated inline agent a "<key>-copy" subagentKey and no children', () => {
    const r = duplicateNode(graph, 'sub:research');
    expect(r.nodeId).toBe('sub:research-copy');
    const clone = r.graph.nodes.find((n) => n.id === r.nodeId);
    expect((clone?.data as AgentNodeData).subagentKey).toBe('research-copy');
    expect(r.graph.nodes.filter((n) => n.owner === r.nodeId)).toEqual([]);
    const entry = graphToSpec(r.graph).spec.subagents?.['research-copy'] as { inline: Record<string, unknown> };
    expect(entry.inline).not.toHaveProperty('tools');
  });
});
