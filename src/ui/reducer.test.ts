/**
 * ReduceAgentEvents() over scripted event sequences, without React.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import { initialAgentUIState, reduceAgentEvents, type AgentUIAction, type AgentUIState } from './reducer';

const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7, inputTokens: 3, outputTokens: 4, estimated: false };

function events(...payloads: AgentEventPayload[]): AgentEvent[] {
  return payloads.map(
    (payload, seq) => ({ ...payload, runId: 'r1', seq, timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION }) as AgentEvent
  );
}

function reduce(...items: (AgentEvent | AgentUIAction)[]): AgentUIState {
  return items.reduce(reduceAgentEvents, initialAgentUIState);
}

const send: AgentUIAction = { type: 'ui.send', input: 'Weather in Paris?' };

describe('reduceAgentEvents', () => {

  it('tool.partial sets the running call\'s partial; tool.done / tool.error clear it', () => {
    const [start1, start2, p0, p1, q0, done1, error2, late] = events(
      { type: 'tool.start', toolCallId: 'c1', toolName: 'a', args: {} },
      { type: 'tool.start', toolCallId: 'c2', toolName: 'b', args: {} },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 1 }, index: 0 },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 2 }, index: 1 },
      { type: 'tool.partial', toolCallId: 'c2', toolName: 'b', output: 'half', index: 0 },
      { type: 'tool.done', toolCallId: 'c1', toolName: 'a', result: { at: 2 }, durationMs: 1 },
      { type: 'tool.error', toolCallId: 'c2', toolName: 'b', error: { name: 'Error', message: 'boom' }, durationMs: 1 },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 'stale' }, index: 2 }
    );
    const midway = reduce(send, start1, start2, p0, p1, q0).messages[1].toolCalls;
    expect(midway.map((c) => [c.id, c.status, c.partial])).toEqual([
      ['c1', 'running', { at: 2 }],
      ['c2', 'running', 'half'],
    ]);

    const settled = reduce(send, start1, start2, p0, p1, q0, done1, error2, late).messages[1].toolCalls;
    expect(settled).toEqual([
      { id: 'c1', name: 'a', args: {}, status: 'done', result: { at: 2 } },
      { id: 'c2', name: 'b', args: {}, status: 'error', error: { name: 'Error', message: 'boom' } },
    ]);
    // A snapshot for a call that is not known is ignored.
    const unknown = events({ type: 'tool.partial', toolCallId: 'zz', toolName: 'a', output: 1, index: 0 });
    expect(reduce(send, ...unknown).messages[1].toolCalls).toEqual([]);
  });

  it('approval.requested pauses; a decision and the resumed outcome finish the turn', () => {
    const paused = reduce(
      send,
      ...events(
        { type: 'text.delta', text: 'Sending.' },
        { type: 'approval.requested', approvalId: 'ap1', toolCallId: 'c1', toolName: 'send_email', args: { to: 'sam' } },
        { type: 'run.done', finishReason: 'awaiting-approval', text: '' }
      )
    );
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pendingApproval).toEqual({ id: 'ap1', toolCallId: 'c1', toolName: 'send_email', args: { to: 'sam' } });
    expect(paused.messages[1].toolCalls[0]).toMatchObject({ id: 'c1', status: 'awaiting-approval' });

    const deciding = reduceAgentEvents(paused, { type: 'ui.decide', approved: true });
    expect(deciding).toMatchObject({ status: 'streaming', pendingApproval: null });
    expect(deciding.messages[1].toolCalls[0].status).toBe('running');

    const done = reduceAgentEvents(deciding, { type: 'ui.resumed', outcome: { text: 'Sent.', finishReason: 'stop', usage } });
    expect(done).toMatchObject({ status: 'idle', usage });
    expect(done.messages[1]).toMatchObject({ text: 'Sending.\n\nSent.', toolCalls: [{ status: 'done' }] });

    const rejected = reduceAgentEvents(paused, { type: 'ui.decide', approved: false });
    expect(rejected.messages[1].toolCalls[0].status).toBe('rejected');
  });

  it('ui.stopped ends a streaming run only; sub-agent events only update lastEvent', () => {
    expect(reduce(send, { type: 'ui.stopped' }).status).toBe('idle');
    expect(reduce({ type: 'ui.stopped' })).toBe(initialAgentUIState);

    const [inner] = events({ type: 'text.delta', text: 'inner' });
    const state = reduce(send, { ...inner, subagent: { name: 'researcher', depth: 1, toolCallId: 'c1' } });
    expect(state.messages[1].text).toBe('');
    expect(state.lastEvent?.subagent?.name).toBe('researcher');
  });

  describe('multi-step text and endings', () => {

    it('records finishReason and the typed object, and shows only the final reply of an output run', () => {
      const state = reduce(
        send,
        ...events(
          { type: 'step.start', step: 1 },
          { type: 'text.delta', text: 'not json' },
          { type: 'step.start', step: 2 },
          { type: 'text.delta', text: '{"a":"x"}' },
          { type: 'run.done', finishReason: 'stop', text: '{"a":"x"}', object: { a: 'x' } }
        )
      );
      expect(state.finishReason).toBe('stop');
      expect(state.status).toBe('idle');
      expect(state.messages[1]).toMatchObject({ text: '{"a":"x"}', finishReason: 'stop', object: { a: 'x' } });
    });

    it.each(['max-steps',] as const)('surfaces a %s ending as an error', (finishReason) => {
      const state = reduce(send, ...events({ type: 'run.done', finishReason, text: 'x', usage }));
      expect(state.status).toBe('error');
      expect(state.error).toMatchObject({ name: 'RunEndedError' });
      expect(state.finishReason).toBe(finishReason);
      expect(state.messages[1].finishReason).toBe(finishReason);
    });
  });
});

describe('partialObject', () => {
  it('follows the top-level object.delta events, ends at run.done object, and resets on the next send', () => {
    const [start, first, inner, last] = events(
      { type: 'run.start', agentName: 'a' },
      { type: 'object.delta', object: { title: 'He' } },
      { type: 'object.delta', object: { title: 'Hello' } },
      { type: 'object.delta', object: { title: 'Hello', tags: ['a'] } }
    );
    const fromSubagent = { ...inner, subagent: { name: 'sub', toolCallId: 't1', depth: 1 } } as AgentEvent;
    expect(reduce(send, start, first, fromSubagent).partialObject).toEqual({ title: 'He' });
    const streaming = reduce(send, start, first, fromSubagent, last);
    expect(streaming.partialObject).toEqual({ title: 'Hello', tags: ['a'] });

    const [done] = events({ type: 'run.done', finishReason: 'stop', text: '', object: { title: 'Hello', tags: ['a', 'b'] } });
    const finished = reduceAgentEvents(streaming, done);
    expect(finished.partialObject).toEqual({ title: 'Hello', tags: ['a', 'b'] });

    expect(reduceAgentEvents(finished, send).partialObject).toBeNull();
    expect(initialAgentUIState.partialObject).toBeNull();
  });
});
