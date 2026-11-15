import { describe, it, expect } from 'vitest';
import {
  authorChatReducer,
  initialAuthorChatState,
  type AuthorChatState,
} from '../authorChatReducer';
import type {
  AuthorAssistantMessage,
  AuthorServerEvent,
  AuthorSessionRecord,
  AuthorUserMessage,
} from '../../../shared/authorWire';

const RECORD: AuthorSessionRecord = {
  schemaVersion: 1,
  id: 'sess-1',
  title: 'First chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  workspaceId: 'ws-1',
  focus: { mode: 'edit', agentId: 'agent-a' },
  transcript: [
    { id: 'm_1', role: 'user', text: 'make it faster', at: '2026-01-01T00:00:10.000Z' },
    {
      id: 'm_2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Done.' }],
      at: '2026-01-01T00:00:20.000Z',
      requestId: 'r_old',
      finishReason: 'stop',
    },
  ],
  createdAgentIds: [],
  runningRequestId: null,
};

function userSent(state: AuthorChatState, requestId: string, text: string): AuthorChatState {
  const message: AuthorUserMessage = {
    id: `local-${requestId}`,
    role: 'user',
    text,
    at: '2026-01-01T00:00:00.000Z',
  };
  return authorChatReducer(state, { type: 'user.sent', requestId, message });
}

function apply(state: AuthorChatState, events: AuthorServerEvent[]): AuthorChatState {
  return events.reduce((s, event) => authorChatReducer(s, { type: 'server.event', event }), state);
}

const TURN_EVENTS: AuthorServerEvent[] = [
  { type: 'turn.started', requestId: 'r_1', seq: 1 },
  { type: 'text.delta', requestId: 'r_1', seq: 2, text: 'Hello' },
  { type: 'text.delta', requestId: 'r_1', seq: 3, text: ', world' },
  { type: 'tool.call', requestId: 'r_1', seq: 4, toolCallId: 'tc_1', name: 'listAgents', input: {} },
  {
    type: 'tool.result',
    requestId: 'r_1',
    seq: 5,
    toolCallId: 'tc_1',
    name: 'listAgents',
    output: { agents: [] },
    state: 'done',
  },
  { type: 'text.delta', requestId: 'r_1', seq: 6, text: 'All listed.' },
  { type: 'turn.finished', requestId: 'r_1', seq: 7, finishReason: 'stop' },
];

describe('authorChatReducer', () => {

  it('turn.finished with no parts leaves no assistant message', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'turn.finished', requestId: 'r_1', seq: 2, finishReason: 'stopped' },
    ]);
    expect(state.active).toBeNull();
    expect(state.messages).toHaveLength(1); // only the user message
  });

  it('turn.error with seq > 0 finishes the turn as error and sets the error note', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'text.delta', requestId: 'r_1', seq: 2, text: 'partial' },
      { type: 'turn.error', requestId: 'r_1', seq: 3, message: 'provider died', code: 'UNAVAILABLE' },
    ]);
    expect(state.active).toBeNull();
    // `retry` marks a mid-turn death: the panel offers "Try again" (resends the last user text).
    expect(state.error).toEqual({ message: 'provider died', code: 'UNAVAILABLE', retry: true });
    const assistant = state.messages.at(-1) as AuthorAssistantMessage;
    expect(assistant.finishReason).toBe('error');
  });

  it('a seq-0 NO_PROVIDER_KEY refusal flips setup to not ready', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const state = apply(sent, [
      { type: 'turn.error', requestId: 'r_1', seq: 0, message: 'No key.', code: 'NO_PROVIDER_KEY' },
    ]);
    expect(state.setup).toEqual({ ready: false });
    expect(state.restoreDraft).toBe('hi');
  });

  it('a seq-0 error for another requestId only notes the error', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const state = apply(sent, [
      { type: 'turn.error', requestId: 'r_old', seq: 0, message: 'This reply is no longer available.', code: 'UNKNOWN_REQUEST' },
    ]);
    expect(state.error?.code).toBe('UNKNOWN_REQUEST');
    // The pending send's optimistic message and active turn are untouched.
    expect(state.messages).toHaveLength(1);
    expect(state.active?.requestId).toBe('r_1');
  });

  it('replaying the same events twice leaves state identical (seq dedupe)', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    // Live delivery reached seq 4 before the drop; the resume then replays
    // the whole turn - seqs 1-4 are dropped, 5-7 apply exactly once.
    const live = apply(sent, TURN_EVENTS.slice(0, 4));
    const replayed = apply(live, TURN_EVENTS);
    const fresh = apply(live, TURN_EVENTS.slice(4));
    expect(replayed).toEqual(fresh);
  });

  it('session.loaded adopts the record and marks a running reply active', () => {
    const running = { ...RECORD, runningRequestId: 'r_live' };
    const state = authorChatReducer(initialAuthorChatState, { type: 'session.loaded', record: running });
    expect(state.sessionId).toBe('sess-1');
    expect(state.title).toBe('First chat');
    expect(state.focus).toEqual({ mode: 'edit', agentId: 'agent-a' });
    expect(state.messages).toBe(RECORD.transcript);
    expect(state.active).toMatchObject({ requestId: 'r_live', lastSeq: 0 });
  });

  it('focus.set, connection and setup update their slices', () => {
    let state = authorChatReducer(initialAuthorChatState, {
      type: 'focus.set',
      focus: { mode: 'edit', agentId: 'a' },
    });
    expect(state.focus).toEqual({ mode: 'edit', agentId: 'a' });
    state = authorChatReducer(state, { type: 'connection', state: 'reconnecting' });
    expect(state.connection).toBe('reconnecting');
    state = authorChatReducer(state, { type: 'setup', ready: false, missingKeyFor: 'anthropic' });
    expect(state.setup).toEqual({ ready: false, missingKeyFor: 'anthropic' });
  });

  it('secret.answered declined stores the DECLINED output on the part', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const withCard = apply(sent, [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'tool.pending', requestId: 'r_1', seq: 2, toolCallId: 'tc_s', name: 'requestSecret', input: { name: 'K' } },
    ]);
    const state = authorChatReducer(withCard, {
      type: 'secret.answered',
      toolCallId: 'tc_s',
      outcome: 'declined',
    });
    const part = state.active!.assistant.parts[0];
    expect(part).toMatchObject({ state: 'done', output: { ok: false, code: 'DECLINED', name: 'K' } });
  });
});
