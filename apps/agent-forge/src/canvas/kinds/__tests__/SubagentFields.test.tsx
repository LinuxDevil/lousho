import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, SubagentNodeData } from '../../../graph/v2/types';
import type { AgentListItem } from '../../../../shared/wireTypes';

const app = vi.hoisted(() => {
  const agents: AgentListItem[] = ['open-agent', 'billing', 'search'].map((id) => ({
    id,
    name: id,
    description: '',
    model: 'mock/mock-1',
    enabled: true,
    labels: [],
    updatedAt: '',
    publishedVersion: null,
    counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  }));
  return {
    graph: undefined as Graph | undefined,
    selectedNodeId: 'sub:billing',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    displayGraph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    agentId: app.agentId,
    agents: app.agents,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

function specOf(subagents: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', subagents } as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

/** Re-render so the Inspector sees the graph `setGraph` just produced. */
function flush() {
  act(() => rerender(<Inspector />));
}

function field<T extends Element = HTMLInputElement>(id: string): T {
  return container.querySelector(`#${id}`) as T;
}

function type(id: string, value: string) {
  act(() => {
    const el = field<HTMLInputElement | HTMLTextAreaElement>(id);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as SubagentNodeData).item;

beforeEach(() => {
  app.selectedNodeId = 'sub:billing';
  app.graph = specToGraph(specOf({ billing: { ref: 'agents/billing.yaml' } }));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('subagent Inspector: ref source', () => {

  it('writes agents/<id>.yaml from the picker', () => {
    renderInspector();
    choose('node-subagent-ref', 'agents/search.yaml');
    expect(item()).toStrictEqual({ ref: 'agents/search.yaml' });
  });

  it('shows the free-path input for a ref outside agents/', () => {
    app.graph = specToGraph(specOf({ billing: { ref: 'shared/helper.yaml' } }));
    renderInspector();
    expect(field('node-subagent-ref-path')).not.toBeNull();
    type('node-subagent-ref-path', 'shared/other.yaml');
    expect(item()).toStrictEqual({ ref: 'shared/other.yaml' });
  });
});

describe('subagent Inspector: source switch and remote', () => {
  it('switches the item to a remote and back', () => {
    renderInspector();
    // ChoiceField (no unset): 1 Agent in this workspace, 2 Remote agent.
    choose('node-subagent-source', '2');
    expect(item()).toStrictEqual({ remote: { url: '', description: '' } });
    flush();
    choose('node-subagent-source', '1');
    expect(item()).toStrictEqual({ ref: '' });
  });

  it('writes a valid https url and flags an invalid one', () => {
    app.selectedNodeId = 'sub:search';
    app.graph = specToGraph(specOf({ search: { remote: { url: '', description: 'd' } } }));
    renderInspector();
    type('node-subagent-url', 'not a url');
    flush();
    expect(container.textContent).toContain('Enter a full URL starting with https://');
    type('node-subagent-url', 'https://search.example.com');
    expect((item() as { remote: { url: string } }).remote.url).toBe('https://search.example.com');
  });

  it('requires a description', () => {
    app.selectedNodeId = 'sub:search';
    app.graph = specToGraph(specOf({ search: { remote: { url: 'https://x.example.com', description: '' } } }));
    renderInspector();
    expect(container.textContent).toContain('A remote agent needs a description');
    type('node-subagent-description', 'Web search agent');
    expect((item() as { remote: { description: string } }).remote.description).toBe('Web search agent');
  });
});
