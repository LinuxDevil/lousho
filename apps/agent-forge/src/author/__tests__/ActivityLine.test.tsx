import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthorToolPart } from '../../../shared/authorWire';
import { ActivityLine } from '../ActivityLine';
import { authorChatReducer, initialAuthorChatState } from '../authorChatReducer';

const failure = {
  ok: false,
  code: 'DRAFT_INVALID',
  error: 'The draft does not match AgentSpec v2: tools[3].owner: Required.',
  userMessage: 'The draft had a few invalid settings. The Author is fixing them.',
};

function part(output: unknown, state: AuthorToolPart['state'] = 'done'): AuthorToolPart {
  return { type: 'tool', toolCallId: 'c1', name: 'proposeAgentUpdate', input: {}, output, state };
}

describe('ActivityLine failure reason', () => {
  it('shows the label and the failure message', () => {
    const html = renderToStaticMarkup(<ActivityLine part={part(failure)} />);
    expect(html).toContain('Couldn&#x27;t draft the change');
    expect(html).toContain(
      '<span class="author-activity-reason">The draft does not match AgentSpec v2: tools[3].owner: Required.</span>'
    );
  });

  it('clips a long message to 200 characters', () => {
    const html = renderToStaticMarkup(<ActivityLine part={part({ ...failure, error: 'x'.repeat(500) })} />);
    expect(html).toContain(`${'x'.repeat(200)}…`);
    expect(html).not.toContain('x'.repeat(201));
  });

  it('shows no reason for a successful call', () => {
    expect(renderToStaticMarkup(<ActivityLine part={part({ ok: true })} />)).not.toContain('author-activity-reason');
  });
});

describe('tool.result event', () => {
  it('lands the failure message on the part the line renders', () => {
    let state = authorChatReducer(initialAuthorChatState, {
      type: 'user.sent',
      requestId: 'r1',
      message: { id: 'u1', role: 'user', text: 'add github tools', at: '2026-01-01T00:00:00.000Z' },
    });
    const base = { requestId: 'r1', toolCallId: 'c1', name: 'proposeAgentUpdate' };
    state = authorChatReducer(state, {
      type: 'server.event',
      event: { type: 'tool.call', ...base, seq: 1, input: {} } as never,
    });
    state = authorChatReducer(state, {
      type: 'server.event',
      event: { type: 'tool.result', ...base, seq: 2, output: failure, state: 'done' },
    });
    const landed = state.active?.assistant.parts[0] as AuthorToolPart;
    expect((landed.output as { error: string }).error).toBe(failure.error);
    expect(renderToStaticMarkup(<ActivityLine part={landed} />)).toContain(failure.error);
  });
});
