import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { toRfEdges, toRfNodes } from '../CanvasArea';
import { deriveEdges } from '../../graph/v2/edges';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';

/** The ticket's worked example: two leaf subagents and one inline group with a tool inside. */
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

const DECOR = {
  selectedNodeId: undefined,
  highlightedNodeId: undefined,
  breakpoints: [],
  statuses: {},
};

function workedGraph() {
  return specToGraph(parse(WORKED) as AgentSpecV2);
}

describe('toRfNodes: subagent groups', () => {
  it('types the inline subagent agent-group and parents its children', () => {
    const nodes = toRfNodes(workedGraph(), DECOR);
    const group = nodes.find((n) => n.id === 'sub:research')!;
    const tool = nodes.find((n) => n.id === 'sub:research/tool:web-fetch')!;
    expect(group.type).toBe('agent-group');
    expect(tool.parentId).toBe('sub:research');
    // Leaf subagent nodes stay ordinary cards.
    expect(nodes.find((n) => n.id === 'sub:billing')!.type).toBe('agent-subagent');
    expect(nodes.find((n) => n.id === 'sub:search')!.type).toBe('agent-subagent');
  });

  it('hides the edges that touch a hidden child', () => {
    const graph = setCollapsed(workedGraph(), 'sub:research', true);
    const nodes = toRfNodes(graph, DECOR);
    const hiddenIds = new Set(nodes.filter((n) => n.hidden).map((n) => n.id));
    const edges = toRfEdges(deriveEdges(graph), {}, undefined, hiddenIds);
    // The `uses` edge into the hidden tool is hidden; edges between visible nodes stay visible.
    expect(edges.find((e) => e.id === 'uses:sub:research->sub:research/tool:web-fetch')!.hidden).toBe(true);
    expect(edges.find((e) => e.id === 'delegates:agent->sub:research')!.hidden).toBe(false);
    expect(edges.find((e) => e.id === 'delegates:agent->sub:billing')!.hidden).toBe(false);
  });
});
