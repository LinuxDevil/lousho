
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './render';

const appState = vi.hoisted(() => ({
  agents: [
    { id: 'support-bot', name: 'Support Bot' },
    { id: 'researcher', name: '' },
  ],
  switchAgent: vi.fn<[string], Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { CommandPalette, buildCommands } from '../CommandPalette';
import { SHORTCUTS } from '../../shell/shortcuts';
import { NAV_ITEMS } from '../../shell/NavRail';
import { applyStoredTheme } from '../../shell/theme';
import { ToastProvider } from '../Toast';

const mount = () =>
  render(
    <ToastProvider>
      <CommandPalette />
    </ToastProvider>,
  );

const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });

const dialog = (name: string) => document.querySelector(`[role="dialog"][aria-label="${name}"]`) as HTMLElement | null;
const input = () => document.querySelector('[role="combobox"]') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);

function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function stubScheme(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.location.hash = '#/traces';
  appState.switchAgent.mockReset();
  appState.switchAgent.mockImplementation(() => Promise.resolve());
  document.documentElement.removeAttribute('data-theme');
  // jsdom's localStorage is unavailable under this Node (see DataTable.test.tsx)
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

describe('CommandPalette', () => {
  it('Ctrl+K opens it, typing filters, Enter navigates and closes', () => {
    mount();
    expect(dialog('Command palette')).toBeNull();
    key('k', { ctrlKey: true });
    expect(dialog('Command palette')?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(options()).toContain('Go to Monitoring');
    expect(options()).toContain('Open agent Support Bot');
    expect(options()).toContain('Toggle theme');

    type('moni');
    expect(options()).toEqual(['Go to Monitoring']);
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/monitoring');
    expect(dialog('Command palette')).toBeNull();
  });

  it('arrow keys move the active option and aria-activedescendant follows', () => {
    mount();
    key('k', { ctrlKey: true });
    type('open agent');
    // the label is the spec name, falling back to the id when the name is empty;
    // 'Open Agent Author' (AA19) matches the query too and sits in Actions, after the agents
    expect(options()).toEqual(['Open agent Support Bot', 'Open agent researcher', 'Open Agent Author']);
    const activeText = () => document.getElementById(input().getAttribute('aria-activedescendant')!)?.textContent;
    expect(activeText()).toBe('Open agent Support Bot');
    key('ArrowDown', {}, input());
    expect(activeText()).toBe('Open agent researcher');
    key('ArrowDown', {}, input());
    expect(activeText()).toBe('Open Agent Author');
    key('ArrowUp', {}, input());
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/agents/researcher/overview');
    // Only the hash: the Agents screen's route sync opens it (and asks about unsaved changes).
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('shows an empty message when nothing matches, and the backdrop closes it', () => {
    mount();
    key('k', { ctrlKey: true });
    type('zzzz');
    expect(options()).toEqual([]);
    expect(document.querySelector('.cmdk-empty')?.textContent).toBe('No matching commands');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    const backdrop = document.querySelector('.cmdk-backdrop')!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(dialog('Command palette')).toBeNull();
  });

  it('? opens the shortcut sheet listing SHORTCUTS; Esc closes it', () => {
    mount();
    key('?');
    const sheet = dialog('Keyboard shortcuts');
    expect(sheet).not.toBeNull();
    expect([...sheet!.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(SHORTCUTS.map((s) => s.keys));
    key('Escape', {}, document.activeElement!);
    expect(dialog('Keyboard shortcuts')).toBeNull();
  });

  it('Toggle theme flips the effective scheme and remembers it', () => {
    stubScheme(true);
    mount();
    key('k', { ctrlKey: true });
    type('theme');
    key('Enter', {}, input());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('forge.theme')).toBe('light');

    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('CommandPalette modal keys', () => {

  it('still toggles with Ctrl+K from inside the palette and lets keys through once closed', () => {
    const behind = vi.fn();
    mount();
    key('k', { ctrlKey: true });
    key('k', { ctrlKey: true }, input());
    expect(dialog('Command palette')).toBeNull();
    window.addEventListener('keydown', behind);
    try {
      key('s', {}, document.body);
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});

describe('CommandPalette groups and look', () => {

  it('"Open Agent Author" and "Describe a new agent with AI" queue their open requests (AA19)', async () => {
    const { takePendingOpen, CREATE_AGENT_DRAFT } = await import('../../author/authorEntry');
    mount();
    key('k', { ctrlKey: true });
    type('open agent author');
    key('Enter', {}, input());
    expect(takePendingOpen()).toEqual({ source: 'palette' });

    key('k', { ctrlKey: true });
    type('describe a new agent');
    key('Enter', {}, input());
    expect(takePendingOpen()).toEqual({
      source: 'agents-list',
      focus: { mode: 'create' },
      draft: CREATE_AGENT_DRAFT,
      newChat: true,
    });
  });

  it('"Go to" commands use the same icon as their nav rail item', () => {
    for (const item of NAV_ITEMS) {
      const cmd = buildCommands(`Go to ${item.label}`, [], () => {}).find((c) => c.id === `go:${item.id}`);
      expect(cmd?.icon, item.id).toBe(item.icon);
    }
  });
});
