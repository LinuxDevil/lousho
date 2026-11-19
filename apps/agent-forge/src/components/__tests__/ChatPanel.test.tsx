import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_INPUT } from '../../../shared/runInput';
import type { ChatMessage } from '../../../shared/wireTypes';
import { Bubble } from '../ChatPanel';

const user = (content: string, source?: ChatMessage['source']): ChatMessage => ({
  id: 'm1',
  role: 'user',
  content,
  timestamp: '2026-01-01T00:00:00Z',
  ...(source ? { source } : {}),
});

const html = (message: ChatMessage) => renderToStaticMarkup(<Bubble message={message} toolResults={new Map()} />);

describe('Bubble', () => {
  it('shows a Run started marker, not the default run input, for the Run button turn', () => {
    const out = html(user(DEFAULT_RUN_INPUT, 'run'));
    expect(out).toContain('Run started');
    expect(out).not.toContain(DEFAULT_RUN_INPUT);
    expect(out).not.toContain('chat-bubble');
  });

  it('still shows typed run input', () => {
    const out = html(user('Summarise the inbox', 'run'));
    expect(out).toContain('Run input');
    expect(out).toContain('Summarise the inbox');
  });

  it('shows an ordinary user message as a bubble', () => {
    const out = html(user('hello'));
    expect(out).toContain('hello');
    expect(out).not.toContain('Run started');
  });
});
