import { describe, it, expect } from 'vitest';
import { applyNodeState, isNewRun } from '../nodeStateReducer';
import type { AgentRunStatusPayload, NodeStatePayload } from '../../../shared/wireTypes';

const frame = (over: Partial<NodeStatePayload> = {}): NodeStatePayload => ({
  nodeId: 'agent',
  state: 'running',
  spanId: 'span-1',
  at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const status = (s: AgentRunStatusPayload['status']): AgentRunStatusPayload =>
  ({ agentId: 'bot', status: s, updatedAt: '' }) as AgentRunStatusPayload;

describe('applyNodeState', () => {

  it('an older `at` frame for the same node is ignored and returns the same object', () => {
    const end = frame({ state: 'done', at: '2026-01-01T00:00:02.000Z' });
    const late = frame({ nodeId: 'tool:http', state: 'running', spanId: 'span-9', at: '2026-01-01T00:00:01.000Z' });
    const states = applyNodeState(applyNodeState({}, end), late);
    // `late` is a different node - it lands; an older frame for `agent` does not.
    expect(states['tool:http']).toBe(late);
    const stale = frame({ state: 'running', spanId: 'span-8', at: '2026-01-01T00:00:00.500Z' });
    expect(applyNodeState(states, stale)).toBe(states);
    expect(states.agent.state).toBe('done');
  });
});

describe('isNewRun', () => {
  it.each<[AgentRunStatusPayload | undefined, AgentRunStatusPayload, boolean]>([
    [status('idle'), status('running'), true],
  ])('prev %s -> next %s = %s', (prev, next, expected) => {
    expect(isNewRun(prev, next)).toBe(expected);
  });
});
