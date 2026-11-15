import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
// Registers the requestSecret renderer for the AuthorMessages mounts.
import '../secretRenderers';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  RequestSecretOutput,
} from '../../../shared/authorWire';
import { AuthorMessages } from '../AuthorMessages';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  authorChatReducer,
  initialAuthorChatState,
  type AuthorChatState,
} from '../authorChatReducer';
import { RuntimeApiError } from '../../runtime/runtimeClient';
import type { AuthorChat } from '../AuthorChatContext';

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {},
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string
    ) {
      super(message);
    }
  },
}));

/** A chat whose actions are spies; `submitSecret` resolves by default. */
function chatWith(over: Partial<AuthorChat> = {}, state: Partial<AuthorChatState> = {}): AuthorChat {
  return {
    state: { ...initialAuthorChatState, connection: 'open', ...state },
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    recheckSetup: vi.fn(),
    dismissError: vi.fn(),
    ...over,
  };
}

let seq = 0;
function secretPart(over: Partial<AuthorToolPart> = {}): AuthorToolPart {
  return {
    type: 'tool',
    toolCallId: `tc_s${++seq}`,
    name: 'requestSecret',
    input: { name: 'JIRA_TOKEN', why: 'The agent posts to Jira.' },
    state: 'pending',
    ...over,
  };
}

function assistant(parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  return { id: `m_a_${++seq}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

function mount(messages: AuthorMessage[], chat: AuthorChat): HTMLDivElement {
  return render(<AuthorMessages messages={messages} active={null} chat={chat} />);
}

function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const valueInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>('.secret-card input[type="password"]')!;
const saveButton = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLButtonElement>('.secret-card button')].find((b) => b.type === 'submit')!;

beforeEach(() => {
  installMemoryStorage();
  window.location.hash = '#/';
});

describe('requestSecret part rendering', () => {

  it('saved, exists and declined parts render their one-line states', () => {
    const outputs: [RequestSecretOutput, string, string, boolean][] = [
      [{ ok: true, name: 'JIRA_TOKEN', status: 'saved' }, 'JIRA_TOKEN saved', 'secret-card-done', true],
      [{ ok: true, name: 'JIRA_TOKEN', status: 'exists' }, 'JIRA_TOKEN is already set', 'secret-card-done', true],
      [
        { ok: false, code: 'DECLINED', name: 'JIRA_TOKEN', error: 'x', userMessage: 'x' },
        'Skipped JIRA_TOKEN',
        'secret-card-done secret-card-done--skipped',
        false,
      ],
    ];
    for (const [output, text, cls, hasIcon] of outputs) {
      const c = mount(
        [assistant([secretPart({ state: 'done', output })])],
        chatWith()
      );
      const done = c.querySelector('.secret-card-done');
      expect(done?.className, text).toBe(cls);
      expect(done?.textContent).toBe(text);
      expect(done?.querySelector('svg') !== null, text).toBe(hasIcon);
      expect(c.querySelector('form.secret-card')).toBeNull();
    }
  });

  it('any other failure keeps the failed activity line', () => {
    const c = mount(
      [
        assistant([
          secretPart({ state: 'error', output: { ok: false, code: 'UNAVAILABLE', error: 'x', userMessage: 'x' } }),
        ]),
      ],
      chatWith()
    );
    expect(c.querySelector('.secret-card')).toBeNull();
    const line = c.querySelector('.author-activity');
    expect(line?.getAttribute('data-state')).toBe('failed');
    expect(line?.textContent).toBe("Couldn't ask for the secret");
  });
});

describe('SecretCard form', () => {
  function pending(): [AuthorToolPart, AuthorMessage[]] {
    const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
    return [part, [assistant([part])]];
  }

  it('Save stays disabled with a reason while the value is empty or a reply streams', () => {
    const [, messages] = pending();
    let c = mount(messages, chatWith());
    expect(saveButton(c).disabled).toBe(true);
    expect(saveButton(c).getAttribute('title')).toBe('Enter a value first');

    c = mount(messages, chatWith({ isStreaming: true }));
    typeInto(valueInput(c), 's3cret');
    expect(saveButton(c).disabled).toBe(true);
    expect(saveButton(c).getAttribute('title')).toBe('Wait for the Author to finish replying');
  });

  it('shows the route error, with a friendly line for NOT_PENDING', async () => {
    const [, messages] = pending();
    let c = mount(
      messages,
      chatWith({
        submitSecret: vi.fn(async () => {
          throw new RuntimeApiError('This request is no longer waiting for a value.', 404, 'NOT_PENDING');
        }),
      })
    );
    typeInto(valueInput(c), 'x');
    await act(async () => {
      saveButton(c).click();
    });
    expect(c.querySelector('.secret-card-error')?.textContent).toBe(
      'This card has expired. Ask the Author to request it again.'
    );

    c = mount(
      messages,
      chatWith({
        submitSecret: vi.fn(async () => {
          throw new RuntimeApiError('Wait for the Author to finish replying, then try again.', 409, 'BUSY');
        }),
      })
    );
    typeInto(valueInput(c), 'x');
    await act(async () => {
      saveButton(c).click();
    });
    expect(c.querySelector('.secret-card-error')?.textContent).toBe(
      'Wait for the Author to finish replying, then try again.'
    );
  });
});

describe('SecretCard secret hygiene', () => {
  it('the value never reaches localStorage', async () => {
    const storage = installMemoryStorage();
    const spy = vi.spyOn(storage, 'setItem');
    const [part, messages] = pendingFixture();
    const chat = chatWith();
    const c = mount(messages, chat);
    typeInto(valueInput(c), 's3cret-v4lue');
    await act(async () => {
      saveButton(c).click();
    });
    expect(chat.submitSecret).toHaveBeenCalledWith(part.toolCallId, 'JIRA_TOKEN', 's3cret-v4lue');
    for (const call of spy.mock.calls) {
      expect(call[1]).not.toContain('s3cret-v4lue');
    }
  });

  it('the value never enters the reducer state after secret.answered', () => {
    const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
    const state: AuthorChatState = { ...initialAuthorChatState, messages: [assistant([part])] };
    const next = authorChatReducer(state, { type: 'secret.answered', toolCallId: part.toolCallId, outcome: 'saved' });
    expect(JSON.stringify(next)).not.toContain('s3cret-v4lue');
    const settled = (next.messages[0] as AuthorAssistantMessage).parts[0] as AuthorToolPart;
    expect(settled.state).toBe('done');
    expect(settled.output).toEqual({ ok: true, name: 'JIRA_TOKEN', status: 'saved' });
  });
});

function pendingFixture(): [AuthorToolPart, AuthorMessage[]] {
  const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
  return [part, [assistant([part])]];
}
