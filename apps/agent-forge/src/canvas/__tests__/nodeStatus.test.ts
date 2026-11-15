import { describe, it, expect } from 'vitest';
import { nodeRunStatuses } from '../nodeStatus';
import type { NodeStates } from '../../state/nodeStateReducer';
import { applyNodeState } from '../../state/nodeStateReducer';
import type { AgentRunStatusPayload, NodeStatePayload, NodeRunState } from '../../../shared/wireTypes';

const status = (s: AgentRunStatusPayload['status'], over: Partial<AgentRunStatusPayload> = {}): AgentRunStatusPayload =>
  ({ agentId: 'bot', status: s, updatedAt: '', ...over }) as AgentRunStatusPayload;

const frame = (nodeId: string, state: NodeRunState, at = '2026-01-01T00:00:00.000Z'): NodeStatePayload => ({
  nodeId,
  state,
  spanId: `${nodeId}:${state}`,
  at,
});

const states = (...frames: NodeStatePayload[]): NodeStates =>
  Object.fromEntries(frames.map((f) => [f.nodeId, f]));

describe('nodeRunStatuses', () => {

  it.each<[NodeRunState, AgentRunStatusPayload['status'] | undefined, string]>([
    ['running', 'stopped', 'idle'],
  ])('frame %s with run %s maps to %s', (state, run, expected) => {
    const runStatus = run === undefined ? undefined : status(run);
    expect(nodeRunStatuses(['agent'], states(frame('agent', state)), runStatus).agent).toBe(expected);
  });

  it('a node stays paused through the approval wait, then runs and finishes with the tool', () => {
    // The approval.wait marker's end emits no node frame (nodeStates.ts),
    // so the waiting frame is the node's latest until the gated tool's
    // real span frames arrive after the resume.
    const ids = ['tool:demo-approval'];
    const waiting = frame('tool:demo-approval', 'waiting', '2026-01-01T00:00:01.000Z');
    let nodeStates: NodeStates = applyNodeState({}, waiting);
    // No clobbering done frame arrives; a repeated status push keeps paused.
    expect(nodeRunStatuses(ids, nodeStates, status('paused'))['tool:demo-approval']).toBe('paused');

    nodeStates = applyNodeState(
      nodeStates,
      frame('tool:demo-approval', 'running', '2026-01-01T00:00:05.000Z')
    );
    // spanId differs from the marker's, and `at` is newer - the wait is over.
    expect(nodeRunStatuses(ids, nodeStates, status('running'))['tool:demo-approval']).toBe('running');

    nodeStates = applyNodeState(
      nodeStates,
      frame('tool:demo-approval', 'done', '2026-01-01T00:00:06.000Z')
    );
    expect(nodeRunStatuses(ids, nodeStates, status('running'))['tool:demo-approval']).toBe('done');
  });

  it('the highest rank wins when several child frames raise one group', () => {
    // done (1) vs error (2) vs running (4) on children of the same group.
    const group = nodeRunStatuses(
      ['sub:g', 'sub:g/tool:a', 'sub:g/tool:b'],
      states(
        frame('sub:g/tool:a', 'done'),
        frame('sub:g/tool:b', 'error', '2026-01-01T00:00:01.000Z')
      ),
      status('error')
    );
    expect(group['sub:g']).toBe('error');
    const running = nodeRunStatuses(
      ['sub:g', 'sub:g/tool:a', 'sub:g/tool:b'],
      states(frame('sub:g/tool:a', 'done'), frame('sub:g/tool:b', 'running', '2026-01-01T00:00:01.000Z')),
      status('running')
    );
    expect(running['sub:g']).toBe('running');
  });
});
