import { describe, it, expect } from 'vitest';
import { toModelMessages, uiEventText, userMessageText } from '../modelMessages';
import type { AuthorAssistantMessage, AuthorUserMessage } from '../../../shared/authorWire';

/**
 * toModelMessages: a stored Author transcript replays to the SDK `Message[]`
 * the Author model sees - never a system message (createAgent adds the
 * instructions), user text prefixed verbatim with its stored turnContext so a
 * re-rendered history is byte-identical and the provider prompt cache keeps
 * hitting.
 */
describe('toModelMessages', () => {
  const userMsg = (text: string, extra?: Partial<AuthorUserMessage>): AuthorUserMessage => ({
    id: 'm_user',
    role: 'user',
    text,
    at: '2026-10-29T10:00:00.000Z',
    ...extra,
  });

  it('sends user text unchanged when no turnContext was stored', () => {
    expect(toModelMessages([userMsg('hi')])).toEqual([{ role: 'user', content: 'hi' }]);
    expect(userMessageText(userMsg('hi'))).toBe('hi');
  });

  it('emits a pending JSON tool result for pending parts and isError for error parts', () => {
    const assistant: AuthorAssistantMessage = {
      id: 'm_asst',
      role: 'assistant',
      at: '2026-10-29T10:00:01.000Z',
      parts: [
        {
          type: 'tool',
          toolCallId: 'tc-pending',
          name: 'requestSecret',
          input: { name: 'API_KEY', why: 'needs it' },
          state: 'pending',
        },
        {
          type: 'tool',
          toolCallId: 'tc-error',
          name: 'runDraft',
          input: {},
          state: 'error',
        },
        {
          type: 'tool',
          toolCallId: 'tc-error-out',
          name: 'saveAgent',
          input: {},
          output: { code: 'NO_PROPOSAL' },
          state: 'error',
        },
      ],
    };

    expect(toModelMessages([assistant])).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tc-pending',
            type: 'function',
            function: { name: 'requestSecret', arguments: '{"name":"API_KEY","why":"needs it"}' },
          },
          { id: 'tc-error', type: 'function', function: { name: 'runDraft', arguments: '{}' } },
          { id: 'tc-error-out', type: 'function', function: { name: 'saveAgent', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-pending',
        toolName: 'requestSecret',
        content: '{"status":"pending","note":"Waiting for the user to answer the card."}',
      },
      {
        role: 'tool',
        toolCallId: 'tc-error',
        toolName: 'runDraft',
        content: '{"error":"Tool failed."}',
        isError: true,
      },
      {
        role: 'tool',
        toolCallId: 'tc-error-out',
        toolName: 'saveAgent',
        content: '{"code":"NO_PROPOSAL"}',
        isError: true,
      },
    ]);
  });

  it('uses null for a done tool part with no output and {} for a call with no input', () => {
    const assistant: AuthorAssistantMessage = {
      id: 'm_asst',
      role: 'assistant',
      at: '2026-10-29T10:00:01.000Z',
      parts: [{ type: 'tool', toolCallId: 'tc1', name: 'listAgents', input: undefined, state: 'done' }],
    };
    const messages = toModelMessages([assistant]);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'tc1', function: { arguments: '{}' } }],
    });
    expect(messages[1]).toMatchObject({ role: 'tool', content: 'null' });
  });
});

describe('uiEventText', () => {
  it('save uses the agent name when one is supplied', () => {
    expect(
      uiEventText({ kind: 'save', proposalId: 'tc_9', agentId: 'support-triage', version: 4 }, { agentName: 'Support triage' })
    ).toBe(
      '[UI event] User applied proposal tc_9. Studio saved agent "Support triage" (id "support-triage") as version 4. This was the user\'s action, not a tool call of yours. Treat the saved spec as the new baseline and do not save it again.'
    );
  });
});
