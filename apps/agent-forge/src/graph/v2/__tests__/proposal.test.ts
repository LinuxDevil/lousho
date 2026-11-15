import { describe, expect, it } from 'vitest';
import type { CanvasLayout } from '../../../../shared/wireTypes';
import { mergeProposal, proposalCounts } from '../proposal';
import { specToGraph } from '../specToGraph';
import type { AgentSpecV2 } from '../specTypes';
import type { Graph, GraphNode } from '../types';

/** The ticket's worked example: one tool, one guardrail, a mock model. */
const BASE = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'x',
  tools: [{ builtin: 'http' }],
  guardrails: [{ id: 'g1', name: 'max-length', on: 'input' }],
} as unknown as AgentSpecV2;

const spec = (over: Record<string, unknown> = {}): AgentSpecV2 => ({ ...BASE, ...over }) as AgentSpecV2;

/** A layout recording every non-note node's current position (what AppState passes). */
function layoutOf(graph: Graph): CanvasLayout {
  const nodes: CanvasLayout['nodes'] = {};
  for (const n of graph.nodes) {
    if (n.kind === 'note') continue;
    nodes[n.id] = { x: n.position.x, y: n.position.y, ...(n.collapsed !== undefined ? { collapsed: n.collapsed } : {}) };
  }
  return { schemaVersion: 1, nodes, notes: [] };
}

const node = (graph: Graph, id: string): GraphNode => graph.nodes.find((n) => n.id === id)!;

describe('mergeProposal layout and order', () => {

  it('keeps the current order when every non-agent node is removed', () => {
    const current = specToGraph(spec({ tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }] }));
    const merged = mergeProposal(current, spec({ tools: [], guardrails: [] }), layoutOf(current));

    expect(merged.nodes.map((n) => n.id)).toEqual(current.nodes.map((n) => n.id));
    expect(proposalCounts(merged)).toEqual({ added: 0, removed: 3, edited: 0 });
  });

  it('takes the collapsed flag from the current node for unchanged and edited nodes', () => {
    const current = specToGraph(spec());
    node(current, 'tool:http').collapsed = true;
    node(current, 'agent').collapsed = false;
    const layout = layoutOf(current);
    layout.nodes['guard:g1'] = { ...layout.nodes['guard:g1'], collapsed: true };
    const merged = mergeProposal(
      current,
      spec({ model: 'openai/gpt-5', guardrails: [{ id: 'g1', name: 'max-length', on: 'output' }] }),
      layout
    );

    expect(node(merged, 'tool:http').proposed).toBeUndefined();
    expect(node(merged, 'tool:http').collapsed).toBe(true);
    expect(node(merged, 'agent').proposed).toBe('edit');
    expect(node(merged, 'agent').collapsed).toBe(false);
    expect(node(merged, 'guard:g1').proposed).toBe('edit');
    expect('collapsed' in node(merged, 'guard:g1')).toBe(false);
  });

  it('carries notes over untouched and keeps the viewport', () => {
    const current = specToGraph(spec());
    current.nodes.push({
      id: 'note:n1',
      kind: 'note',
      owner: null,
      position: { x: 5, y: 6 },
      data: { text: 'hi' },
    });
    current.viewport = { x: 1, y: 2, zoom: 0.8 };
    const merged = mergeProposal(current, spec({ model: 'openai/gpt-5' }), layoutOf(current));

    const note = node(merged, 'note:n1');
    expect(note.kind).toBe('note');
    expect(note.proposed).toBeUndefined();
    expect(note.position).toEqual({ x: 5, y: 6 });
    expect(merged.viewport).toEqual({ x: 1, y: 2, zoom: 0.8 });
  });
});
