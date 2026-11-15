import { describe, it, expect } from 'vitest';
import type { Message } from 'lousho';
import { markSteerInputs } from '../chatReconcile';
import type { ChatMessage, SteerInfo } from '../../shared/wireTypes';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:00:05.000Z';

function chatMsg(m: Message & { content: string }, id: string, timestamp = T1): ChatMessage {
  return { ...m, id, timestamp };
}

describe('markSteerInputs', () => {
  const steer = (message: string, delivery: SteerInfo['delivery']): SteerInfo => ({
    id: `steer-${message}`,
    message,
    at: T1,
    delivery,
    mode: 'queued',
  });

  it('tags a new user message whose content equals a delivered steer message', () => {
    const prev: ChatMessage[] = [chatMsg({ role: 'user', content: 'hi' }, 'user-1', T1)];
    const messages: ChatMessage[] = [
      ...prev,
      chatMsg({ role: 'assistant', content: 'ok' }, 'asst-1', T2),
      chatMsg({ role: 'user', content: 'use Paris instead' }, 'user-2', T2),
      chatMsg({ role: 'assistant', content: 'noted' }, 'asst-2', T2),
    ];

    const result = markSteerInputs(messages, prev, [steer('use Paris instead', 'delivered')]);

    expect(result[2]).toMatchObject({ id: 'user-2', source: 'steer' });
    // Everything else is untouched - no source invented elsewhere.
    expect(result[0].source).toBeUndefined();
    expect(result[1].source).toBeUndefined();
    expect(result[3].source).toBeUndefined();
  });
});
