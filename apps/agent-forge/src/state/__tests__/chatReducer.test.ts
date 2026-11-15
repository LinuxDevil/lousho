import { describe, it, expect } from 'vitest';
import { applyChatState, emptyChatState } from '../chatReducer';
import type { ChatMessage, ChatStatePayload } from '../../../shared/wireTypes';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? Math.random().toString(36),
    role: 'user',
    content: 'hi',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function payload(overrides: Partial<ChatStatePayload> = {}): ChatStatePayload {
  return { agentId: 'agent-1', sessionId: 'session-1', messages: [], ...overrides };
}

describe('applyChatState', () => {

  it('drops a stale, out-of-order push for the same session with FEWER messages than already shown', () => {
    const first = applyChatState(emptyChatState(), payload({ messages: [msg({ id: '1' }), msg({ id: '2' })] }));
    const stale = applyChatState(first, payload({ messages: [msg({ id: '1' })] }));
    expect(stale).toBe(first);
    expect(stale.messages.map((m) => m.id)).toEqual(['1', '2']);
  });
});
