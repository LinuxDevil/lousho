
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import type { AgentRunStatusPayload, SpanEvent } from '../../../../shared/wireTypes';
import type { TraceViewerProps } from '../../../ui/run/TraceViewer';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';

const state = vi.hoisted(() => ({
  spansNodeId: undefined as string | undefined,
  spans: [] as SpanEvent[],
  runStatus: undefined as AgentRunStatusPayload | undefined,
  closeNodeSpans: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    spansNodeId: state.spansNodeId,
    closeNodeSpans: state.closeNodeSpans,
    displayGraph: specToGraph({
      version: 2,
      name: 'a',
      model: 'mock/mock-1',
      instructions: 'x',
      tools: [{ builtin: 'http' }],
    } as unknown as AgentSpecV2),
    spans: state.spans,
    runStatus: state.runStatus,
  }),
}));

const viewer = vi.hoisted(() => ({ props: undefined as TraceViewerProps | undefined }));
vi.mock('../../../ui/run/TraceViewer', () => ({
  TraceViewer: (props: TraceViewerProps) => {
    viewer.props = props;
    return <div className="trace-viewer-mock" />;
  },
}));

import { NodeSpansSheet } from '../NodeSpansSheet';

function span(id: string, nodeId: string, parentId?: string): SpanEvent {
  return { id, name: id, parentId, startTime: 1, attributes: { 'lousho.node.id': nodeId } };
}

const sheet = () => document.body.querySelector<HTMLElement>('.sheet');
const description = () => sheet()?.querySelector('.sheet-description')?.textContent;

describe('NodeSpansSheet', () => {
  beforeEach(() => {
    state.spansNodeId = undefined;
    state.spans = [];
    state.runStatus = undefined;
    state.closeNodeSpans = vi.fn();
    viewer.props = undefined;
  });

  it('renders nothing while spansNodeId is undefined', () => {
    render(<NodeSpansSheet />);
    expect(sheet()).toBeNull();
  });

  it('says "this run" while the run is live', () => {
    state.spansNodeId = 'tool:http';
    state.spans = [span('s1', 'tool:http')];
    state.runStatus = { agentId: 'a', status: 'running', updatedAt: '' } as AgentRunStatusPayload;
    render(<NodeSpansSheet />);
    expect(description()).toBe('1 span from this run');
  });

  it('shows the empty state — and still opens — when the node has no spans', () => {
    state.spansNodeId = 'tool:http';
    state.spans = [span('s1', 'agent')];
    render(<NodeSpansSheet />);
    expect(sheet()).not.toBeNull();
    expect(sheet()?.querySelector('.node-spans-empty')?.textContent).toContain(
      'This node has no spans in the last run.'
    );
    expect(viewer.props).toBeUndefined();
  });
});
