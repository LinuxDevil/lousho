import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../../ui/__tests__/render';

import { Inspector } from '../../../../components/Inspector';
import { specToGraph } from '../../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../../graph/v2/specTypes';
import type { AgentNodeData, Graph } from '../../../../graph/v2/types';
import type { CatalogModel } from '../../../../../shared/wireTypes';
import type { CatalogState } from '../../../../canvas/useCatalog';

const catalog = vi.hoisted(() => {
  const MODELS: CatalogModel[] = [
    {
      id: 'openai/gpt-5',
      modelId: 'gpt-5',
      provider: 'openai',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: true,
    },
  ];
  return { state: { data: MODELS, error: undefined, loading: false } as CatalogState<CatalogModel[]> };
});

vi.mock('../../../../canvas/useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: vi.fn(),
}));

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'agent',
  setGraph: vi.fn(),
}));

vi.mock('../../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    displayGraph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

function specOf(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'openai/gpt-5', instructions: 'Be brief.', ...over } as AgentSpecV2;
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

function click(id: string) {
  act(() => {
    field<HTMLButtonElement>(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const fields = () => (app.graph!.nodes[0].data as AgentNodeData).fields;

beforeEach(() => {
  app.selectedNodeId = 'agent';
  app.graph = specToGraph(specOf());
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('agent run settings Inspector', () => {
  it('writes limits.maxCostUsd and deletes limits when it is the last key cleared', () => {
    renderInspector();
    type('node-agent-max-cost', '2.5');
    expect(fields().limits).toStrictEqual({ maxCostUsd: 2.5 });
    flush();
    type('node-agent-max-cost', '');
    expect(fields().limits).toBeUndefined();
  });

  it('rejects an approval timeout under 30 seconds without writing it', () => {
    renderInspector();
    type('node-agent-approval-ttl', '10000');
    flush();
    expect(container.textContent).toContain('At least 30 seconds');
    expect(fields().approvalTtlMs).toBeUndefined();
  });

  it('writes retry:false for Off and shows the three custom fields for Custom', () => {
    renderInspector();
    // Retries ChoiceField (allowUnset): 0 Default, 1 Off, 2 Custom.
    choose('node-agent-retry', '1');
    expect(fields().retry).toBe(false);
    flush();
    choose('node-agent-retry', '2');
    expect(fields().retry).toStrictEqual({});
    flush();
    expect(field('node-agent-retry-max')).not.toBeNull();
    expect(field('node-agent-retry-backoff')).not.toBeNull();
    expect(field('node-agent-retry-timeout')).not.toBeNull();
  });

  it('keeps custom backoff sub-keys when the preset is re-picked', () => {
    app.graph = specToGraph(specOf({ retry: { backoff: { initialMs: 100, jitter: false } } }));
    renderInspector();
    // Backoff ChoiceField (allowUnset): 0 Default, 1 Exponential, 2 Linear.
    choose('node-agent-retry-backoff', '2');
    expect(fields().retry).toStrictEqual({ backoff: { initialMs: 100, jitter: false, factor: 1 } });
  });

  it('writes compaction custom threshold and summarizer', () => {
    renderInspector();
    // Compaction ChoiceField (allowUnset): 0 Default, 1 On, 2 Off, 3 Custom.
    choose('node-agent-compaction', '3');
    expect(fields().compaction).toStrictEqual({});
    flush();
    type('node-agent-compaction-threshold', '0.8');
    expect(fields().compaction).toStrictEqual({ thresholdPercent: 0.8 });
    flush();
    // The summarizer ModelPicker is a select until "Other…" switches it to free text.
    choose('node-agent-compaction-model', '__other__');
    flush();
    type('node-agent-compaction-model', 'anthropic/claude-sonnet-5-5');
    expect(fields().compaction).toStrictEqual({
      thresholdPercent: 0.8,
      summarizer: 'anthropic/claude-sonnet-5-5',
    });
  });

  it('keeps compaction:false distinct from deleting the key', () => {
    renderInspector();
    // 2 = Off.
    choose('node-agent-compaction', '2');
    expect(fields().compaction).toBe(false);
    flush();
    choose('node-agent-compaction', '0');
    expect(fields().compaction).toBeUndefined();
  });

  it('writes toolSearch false off and an object on, keeping maxResults inside it', () => {
    renderInspector();
    // Absent means on (the SDK default); the first click turns it off.
    click('node-agent-tool-search');
    expect(fields().toolSearch).toBe(false);
    flush();
    expect(field('node-agent-tool-search-max-results')).toBeNull();
    click('node-agent-tool-search');
    expect(fields().toolSearch).toStrictEqual({});
    flush();
    type('node-agent-tool-search-max-results', '8');
    expect(fields().toolSearch).toStrictEqual({ maxResults: 8 });
  });

  it('writes codeMode true on and deletes the key off', () => {
    renderInspector();
    click('node-agent-code-mode');
    expect(fields().codeMode).toBe(true);
    flush();
    click('node-agent-code-mode');
    expect(fields().codeMode).toBeUndefined();
  });

  it('writes subagentOptions.maxConcurrent and maxSubagentDepth', () => {
    renderInspector();
    type('node-agent-subagent-max-concurrent', '2');
    expect(fields().subagentOptions).toStrictEqual({ maxConcurrent: 2 });
    flush();
    type('node-agent-max-subagent-depth', '2');
    expect(fields().maxSubagentDepth).toBe(2);
    type('node-agent-max-handoffs', '5');
    expect(fields().maxHandoffs).toBe(5);
  });
});
