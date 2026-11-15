import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

import { AuthorRouteFocus } from '../useRouteFocus';
import { markAuthorFocusCleared, resetAuthorFocusCleared, takePendingOpen } from '../authorEntry';
import { initialAuthorChatState } from '../authorChatReducer';
import type { AuthorChat } from '../AuthorChatContext';
import type { AuthorFocus } from '../../../shared/authorWire';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';

/** A chat stub: route focus only reads `state.focus` and calls `setFocus`. */
function chatWith(focus: AuthorFocus = { mode: 'create' }): AuthorChat {
  return {
    state: { ...initialAuthorChatState, focus },
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(),
    recheckSetup: vi.fn(),
    dismissError: vi.fn(),
  };
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  installMemoryStorage();
  resetAuthorFocusCleared();
  window.location.hash = '#/';
});

afterEach(() => {
  resetAuthorFocusCleared();
  takePendingOpen();
});

describe('AuthorRouteFocus', () => {

  it('drops the route-set edit focus back to a new agent when leaving agent pages', () => {
    const chat = chatWith({ mode: 'edit', agentId: 'alpha' });
    mocks.chat = chat;
    window.location.hash = '#/agents/alpha/canvas';
    render(<AuthorRouteFocus />);
    go('#/agents');
    expect(chat.setFocus).toHaveBeenCalledWith({ mode: 'create' });
  });

  it('keeps an edit focus the route did not set when leaving agent pages', () => {
    const chat = chatWith({ mode: 'edit', agentId: 'other' });
    mocks.chat = chat;
    window.location.hash = '#/agents/alpha/canvas';
    render(<AuthorRouteFocus />);
    vi.mocked(chat.setFocus).mockClear();
    chat.state = { ...chat.state, focus: { mode: 'edit', agentId: 'other' } };
    go('#/traces');
    expect(chat.setFocus).not.toHaveBeenCalled();
  });

  it('a cleared chip survives further navigation in the same chat', () => {
    const chat = chatWith();
    mocks.chat = chat;
    window.location.hash = '#/agents/support-triage/canvas';
    render(<AuthorRouteFocus />);
    expect(chat.setFocus).toHaveBeenCalledTimes(1);

    markAuthorFocusCleared(); // the chip's clear button
    vi.mocked(chat.setFocus).mockClear();
    go('#/agents/support-triage/runs');
    go('#/agents/beta/canvas');
    expect(chat.setFocus).not.toHaveBeenCalled();
  });
});
