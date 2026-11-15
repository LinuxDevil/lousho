import { describe, expect, it } from 'vitest';

import { KIND_RULES } from '../kindRules';
import { addNode } from '../mutations';
import type { AgentSpecV2 } from '../specTypes';
import { specToGraph } from '../specToGraph';
import type { Graph, GraphNode, Problem } from '../types';
import { validateGraph } from '../validateGraph';

const AT = { x: 0, y: 0 };

function minimalSpec(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function inlineAgent(over: Record<string, unknown> = {}): { inline: Record<string, unknown> } {
  return {
    inline: { name: 's', description: 'd', model: 'mock/mock-1', instructions: 'x', ...over },
  };
}

/** Replaces `nodeId`'s fields via `patch` (test-local structural edit). */
function editNode(graph: Graph, nodeId: string, patch: Partial<GraphNode>): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as GraphNode) : n)),
  };
}

function error(nodeId: string, message: string, fieldPath?: string): Problem {
  return fieldPath === undefined
    ? { nodeId, severity: 'error', message }
    : { nodeId, severity: 'error', message, fieldPath };
}

describe('validateGraph: core checks', () => {

  it('reports a root-only kind owned by an inline agent', () => {
    const g = specToGraph(
      minimalSpec({
        triggers: [{ id: 't1', type: 'chat' }],
        subagents: { r: inlineAgent({ name: 'r' }) },
      })
    );
    expect(validateGraph(editNode(g, 'trigger:t1', { owner: 'sub:r' }))).toStrictEqual([
      error('trigger:t1', 'Only the main agent can have this'),
    ]);
  });

  it('reports two mcp nodes of one owner sharing a key', () => {
    let g = specToGraph(minimalSpec());
    const data: GraphNode['data'] = { key: 'github', item: { command: 'x' } };
    g = addNode(g, { kind: 'mcp', data }, AT, 'agent').graph;
    g = addNode(g, { kind: 'mcp', data }, AT, 'agent').graph;
    expect(validateGraph(g)).toStrictEqual([
      error('mcp:github', "Two MCP servers are named 'github'", 'mcpServers.github'),
      error('mcp:github#2', "Two MCP servers are named 'github'", 'mcpServers.github'),
    ]);
  });

  it('reports two subagent nodes of one owner sharing a key', () => {
    let g = specToGraph(minimalSpec());
    const data: GraphNode['data'] = { key: 'r', item: { ref: 'agents/r.yaml' } };
    g = addNode(g, { kind: 'subagent', data }, AT, 'agent').graph;
    g = addNode(g, { kind: 'subagent', data }, AT, 'agent').graph;
    expect(validateGraph(g)).toStrictEqual([
      error('sub:r', "Two subagents are named 'r'", 'subagents.r'),
      error('sub:r#2', "Two subagents are named 'r'", 'subagents.r'),
    ]);
  });

  it('reports two memory nodes of one owner sharing a name', () => {
    let g = specToGraph(minimalSpec());
    const data: GraphNode['data'] = {
      item: { name: 'm', scope: 'session', provider: { type: 'in-memory' } },
    };
    g = addNode(g, { kind: 'memory', data }, AT, 'agent').graph;
    g = addNode(g, { kind: 'memory', data }, AT, 'agent').graph;
    expect(validateGraph(g)).toStrictEqual([
      error('memory:m', "Two memory slots are named 'm'", 'memory[0].name'),
      error('memory:m#2', "Two memory slots are named 'm'", 'memory[1].name'),
    ]);
  });

  it('reports two output nodes on one agent', () => {
    let g = specToGraph(minimalSpec());
    const data: GraphNode['data'] = { item: { jsonSchema: { type: 'object' } } };
    g = addNode(g, { kind: 'output', data }, AT, 'agent').graph;
    g = addNode(g, { kind: 'output', data }, AT, 'agent').graph;
    expect(validateGraph(g)).toStrictEqual([
      error('output', 'An agent can have only one output schema', 'output'),
      error('output#2', 'An agent can have only one output schema', 'output'),
    ]);
  });
});

describe('validateGraph: ordering', () => {
  it('puts the graph-level problem first', () => {
    const g: Graph = {
      version: 2,
      nodes: [
        { id: 'tool:x', kind: 'tool', owner: 'ghost', position: AT, data: { item: { builtin: 'x' } } },
      ],
      emptySections: [],
      unplaced: [],
    };
    const problems = validateGraph(g);
    expect(problems[0]).toStrictEqual(error('agent', 'The graph has no main agent'));
    expect(problems).toContainEqual(error('tool:x', 'This node belongs to an agent that no longer exists'));
  });

  it('orders node problems by walk order and errors before warnings within a node', () => {
    const g = specToGraph(minimalSpec({ tools: [{ builtin: 'x' }] }));
    const dup: Graph = { ...g, nodes: [...g.nodes, { ...g.nodes[1] }] };
    KIND_RULES.tool = {
      validate: (node) => [{ nodeId: node.id, severity: 'warning', message: 'tool warning' }],
    };
    try {
      const problems = validateGraph(dup);
      const onTool = problems.filter((p) => p.nodeId === 'tool:x');
      expect(onTool.at(0)?.severity).toBe('error');
      expect(onTool.at(-1)?.severity).toBe('warning');
      expect(problems.at(0)?.nodeId).toBe('tool:x');
    } finally {
      delete KIND_RULES.tool;
    }
  });
});
