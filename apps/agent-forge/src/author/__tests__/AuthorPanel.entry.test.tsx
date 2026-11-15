import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const appState = vi.hoisted(() => ({ connected: true, agents: [], agentId: 'my-agent' }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

import { AppShell } from '../../shell/AppShell';
import { DOCK_OPEN_KEY } from '../../shell/dockState';
import { AuthorPanel } from '../AuthorPanel';
import { openAuthor, takePendingOpen } from '../authorEntry';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { ToastProvider } from '../../ui/Toast';
import type { AuthorChat } from '../AuthorChatContext';
import type { AuthorMessage, AuthorUserMessage } from '../../../shared/authorWire';

function stubWide() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** A chat whose actions are spies; state overrides merge over a ready, connected baseline. */
function chatWith(over: Partial<AuthorChatState> = {}): AuthorChat {
  const state: AuthorChatState = {
    ...initialAuthorChatState,
    connection: 'open',
    setup: { ready: true },
    ...over,
  };
  return {
    state,
    isStreaming: state.active !== null,
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

let userSeq = 0;
function user(text: string): AuthorUserMessage {
  return { id: `m_u_${++userSeq}`, role: 'user', text, at: '2026-01-01T00:00:00.000Z' };
}

const MESSAGES: AuthorMessage[] = [user('Build me a triage agent')];

/** Mounts the real AppShell with the panel as its dock (the same tree App.tsx builds). */
function mount(chat: AuthorChat, dockOpen = true): HTMLDivElement {
  mocks.chat = chat;
  window.localStorage.setItem(DOCK_OPEN_KEY, dockOpen ? '1' : '0');
  return render(
    <ToastProvider>
      <AppShell dock={<AuthorPanel />}>
        <p>screen</p>
      </AppShell>
    </ToastProvider>
  );
}

const input = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>('.author-input')!;
const aside = (c: HTMLElement) => c.querySelector('aside#app-dock');

function typeInto(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  installMemoryStorage();
  stubWide();
  window.location.hash = '#/';
  takePendingOpen(); // drain anything a previous test left queued
});

afterEach(() => {
  vi.restoreAllMocks();
  takePendingOpen();
});

describe('pending open consumption', () => {

  it('a draft never overwrites text the user already typed', () => {
    const chat = chatWith();
    const c = mount(chat);
    typeInto(input(c), 'my own words');
    act(() => openAuthor({ source: 'header', draft: 'Create an agent that ' }));
    expect(input(c).value).toBe('my own words');
    // Focus/draft requests without a draft still focus the composer.
    expect(document.activeElement).toBe(input(c));
  });

  it('a newChat request while a save runs delegates to chat.newChat, which refuses it', () => {
    const chat = chatWith({ messages: MESSAGES, saving: { proposalId: 'tc_9' } });
    const c = mount(chat);
    act(() => openAuthor({ source: 'palette', newChat: true, focus: { mode: 'create' }, draft: 'draft text' }));
    // The panel asks; the chat's own guard refuses the reset while saving.
    expect(chat.newChat).toHaveBeenCalledWith({ mode: 'create' });
    // Focus and draft still apply to the continuing conversation.
    expect(chat.setFocus).toHaveBeenCalledWith({ mode: 'create' });
    expect(input(c).value).toBe('draft text');
  });
});

describe('Ctrl/Cmd+J toggle', () => {
  it('closed → opens the dock with the composer focused; again → closes it', () => {
    const chat = chatWith();
    const c = mount(chat, false);
    expect(aside(c)).toBeNull();

    press('j', { ctrlKey: true });
    expect(aside(c)).not.toBeNull();
    expect(document.activeElement).toBe(input(c));

    press('j', { metaKey: true }); // Cmd+J works too
    expect(aside(c)).toBeNull();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('0');
  });
});
