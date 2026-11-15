import { describe, expect, it } from 'vitest';
import { applyLayoutResult, autoLayout } from '../layout';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { CanvasLayout } from '../../../shared/wireTypes';
import type { Graph, GraphNode } from '../../graph/v2/types';

/** Root agent + trigger + tool + an inline subagent group with its own tool. */
const SPEC = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'hi',
  tools: [{ builtin: 'http' }],
  triggers: [{ id: 't1', type: 'chat' }],
  subagents: {
    research: {
      inline: {
        name: 'research',
        description: 'd',
        model: 'mock/mock-1',
        instructions: 'x',
        tools: [{ builtin: 'web-fetch' }],
      },
    },
  },
} as const;

const GROUP_ID = 'sub:research';
const GROUP_TOOL_ID = 'sub:research/tool:web-fetch';

function graph(layout?: CanvasLayout): Graph {
  return specToGraph(SPEC as never, layout);
}

function byId(g: Graph, id: string): GraphNode {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

describe('applyLayoutResult', () => {

  it('keeps a node\'s position when it moved while the layout ran', () => {
    const before = graph();
    const laidOut: Graph = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === 'agent' ? { ...n, position: { x: 700, y: 700 } } : n)),
    };
    const agentBefore = byId(before, 'agent').position;
    const latest: Graph = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === 'agent' ? { ...n, position: { x: 42, y: 43 } } : n)),
    };
    const merged = applyLayoutResult(before, laidOut, latest);
    expect(byId(merged, 'agent').position).toStrictEqual({ x: 42, y: 43 });
    expect(agentBefore).not.toStrictEqual({ x: 42, y: 43 });
  });
});

describe('autoLayout', () => {

  it('lays out a collapsed group as a leaf without touching its children', async () => {
    const original = setCollapsed(graph(), GROUP_ID, true);
    const before = byId(original, GROUP_TOOL_ID).position;
    const laidOut = await autoLayout(original, 'all');
    expect(byId(laidOut, GROUP_TOOL_ID).position).toStrictEqual(before);
    expect(byId(laidOut, GROUP_ID).position).not.toStrictEqual(byId(original, GROUP_ID).position);
  });

  it('scope \'unplaced\' moves only unplaced nodes, leaves placed ones untouched and clears unplaced', async () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: {
        agent: { x: 40, y: 60 },
        'tool:http': { x: 500, y: 60 },
        [GROUP_ID]: { x: 800, y: 60 },
        [GROUP_TOOL_ID]: { x: 30, y: 120 },
      },
      notes: [],
    };
    const original = graph(layout);
    expect(original.unplaced).toEqual(['trigger:t1']);

    const laidOut = await autoLayout(original, 'unplaced');
    expect(laidOut.unplaced).toEqual([]);
    for (const id of ['agent', 'tool:http', GROUP_ID, GROUP_TOOL_ID]) {
      expect(byId(laidOut, id).position).toStrictEqual(byId(original, id).position);
    }
    expect(byId(laidOut, 'trigger:t1').position).not.toStrictEqual(byId(original, 'trigger:t1').position);
  });

  it('never moves notes', async () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 40, y: 60 } },
      notes: [{ id: 'n1', x: 12, y: -40, text: 'remember this' }],
    };
    const original = graph(layout);
    const noteBefore = byId(original, 'note:n1').position;
    const laidOut = await autoLayout(original, 'all');
    expect(byId(laidOut, 'note:n1').position).toStrictEqual(noteBefore);
  });
});
