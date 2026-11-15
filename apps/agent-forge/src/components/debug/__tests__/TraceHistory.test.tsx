import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { TracePanel } from '../TracePanel';
import type { AgentRunStatusPayload, SpanEvent, TraceSummaryPayload } from '../../../../shared/wireTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listTraces: vi.fn(),
  readTrace: vi.fn(),
  appState: {} as Record<string, unknown>,
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { listTraces: mocks.listTraces, readTrace: mocks.readTrace },
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => mocks.appState }));

// What `GET /agents/:id/traces` returns for an agent that ran twice, the newer run failing.
const TRACES: TraceSummaryPayload[] = [
  {
    traceId: 'trace-new',
    name: 'invoke_agent weather',
    agent: 'weather',
    startTime: Date.parse('2026-10-02T10:05:00Z'),
    durationMs: 1650,
    status: 'error',
    modelCalls: 2,
    toolCalls: 1,
    inputTokens: 159,
    outputTokens: 32,
    costUsd: 0.000043,
  },
  {
    traceId: 'trace-old',
    name: 'invoke_agent weather',
    startTime: Date.parse('2026-10-02T10:00:00Z'),
    durationMs: 420,
    status: 'ok',
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
  },
];

// What `GET /agents/:id/traces/trace-new` returns: a root, a model call and a failed tool call.
const PAST_SPANS: SpanEvent[] = [
  { id: 'trace-new', name: 'invoke_agent weather', startTime: 1000, endTime: 2650, kind: 'internal', status: { code: 'error', message: 'boom' }, attributes: { 'gen_ai.operation.name': 'invoke_agent' } },
  { id: 'c1', parentId: 'trace-new', name: 'chat gpt-4o-mini', startTime: 1000, endTime: 1900, kind: 'client', attributes: { 'gen_ai.operation.name': 'chat' } },
  { id: 't1', parentId: 'trace-new', name: 'execute_tool get_weather', startTime: 1900, endTime: 1920, kind: 'internal', status: { code: 'error', message: 'boom' }, attributes: { 'gen_ai.operation.name': 'execute_tool' } },
];

const LIVE_SPANS: SpanEvent[] = [
  { id: 'live-root', name: 'invoke_agent live-run', startTime: 5000, attributes: {} },
];

const statusOf = (status: AgentRunStatusPayload['status']): AgentRunStatusPayload => ({ agentId: 'weather', status, updatedAt: '2026-10-02T10:00:00.000Z' });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TracePanel with trace history', () => {
  beforeEach(() => {
    mocks.listTraces.mockResolvedValue(TRACES);
    mocks.readTrace.mockResolvedValue(PAST_SPANS);
    mocks.appState.agentId = 'weather';
    mocks.appState.spans = [];
    mocks.appState.runStatus = statusOf('stopped');
    mocks.appState.highlightedNodeId = undefined;
    mocks.appState.setHighlightedNodeId = vi.fn();
    mocks.appState.setDrawerTab = vi.fn();
    mocks.appState.graph = { version: 2, nodes: [], emptySections: [], unplaced: [] };
    mocks.appState.nodeIdMap = {};
  });

  it('lists the agent traces and shows the selected one in the shared trace viewer with kind and error status', async () => {
    const container = render(<TracePanel />);
    await flush();
    expect(mocks.listTraces).toHaveBeenCalledWith('weather');
    expect(container.querySelectorAll('[role=option]')).toHaveLength(2);

    act(() => (container.querySelectorAll('[role=option]')[0] as HTMLElement).click());
    await flush();
    expect(mocks.readTrace).toHaveBeenCalledWith('weather', 'trace-new');
    const rows = [...container.querySelectorAll('.run-tree-row')];
    expect(rows.map((row) => row.querySelector('.run-name')?.textContent)).toEqual([
      'invoke_agent weather',
      'chat gpt-4o-mini',
      'execute_tool get_weather',
    ]);
    expect(rows.map((row) => row.querySelector('.run-kind')?.getAttribute('data-kind'))).toEqual(['span', 'generation', 'tool']);
    expect(rows[2].classList.contains('run-row-error')).toBe(true);
    expect(rows[1].classList.contains('run-row-error')).toBe(false);
    // A failed trace opens on its first error, with the span's message in the Error banner.
    expect(container.querySelector('.run-inspector')?.getAttribute('data-obs-id')).toBe('trace-new');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('boom');
    // Drawer runs are not observe traces: no dead "Open in Playground" link on the model call.
    act(() => (container.querySelector('[data-obs-id="c1"] .run-row-main') as HTMLElement).click());
    expect(container.querySelector('.run-inspector')?.getAttribute('data-obs-id')).toBe('c1');
    expect(container.querySelectorAll('.run-playground-link')).toHaveLength(0);
  });

  it('switches between the tree and the waterfall', async () => {
    const container = render(<TracePanel />);
    await flush();
    act(() => (container.querySelectorAll('[role=option]')[0] as HTMLElement).click());
    await flush();
    const waterfall = [...container.querySelectorAll('.run-mode-toggle button')].find((b) => b.textContent === 'Waterfall') as HTMLElement;
    act(() => waterfall.click());
    expect(container.querySelectorAll('.run-wf-row')).toHaveLength(3);
    expect(container.querySelector('.run-tree')).toBeNull();
  });

  it('jumps to the Logs tab when a live step is selected', async () => {
    mocks.appState.runStatus = statusOf('running');
    mocks.appState.spans = LIVE_SPANS;
    const container = render(<TracePanel />);
    await flush();
    act(() => (container.querySelector('.run-row-main') as HTMLElement).click());
    expect(mocks.appState.setDrawerTab).toHaveBeenCalledWith('logs');
  });

  it('says why the list is empty when the server cannot be read', async () => {
    mocks.listTraces.mockRejectedValue(new Error('No saved agent'));
    const container = render(<TracePanel />);
    await flush();
    expect(container.textContent).toContain('No saved agent');
  });
});
