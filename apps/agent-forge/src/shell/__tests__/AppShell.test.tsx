import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ connected: true, agents: [], switchAgent: () => Promise.resolve() }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { AppShell } from '../AppShell';
import { ToastProvider } from '../../ui/Toast';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function stubNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ToastProvider>
        <AppShell>
          <p id="screen">screen</p>
        </AppShell>
      </ToastProvider>,
    ),
  );
}

const nav = () => container.querySelector('nav[aria-label="Primary"]') as HTMLElement;
const toggle = () => container.querySelector('button[aria-label="Navigation"]') as HTMLButtonElement | null;
const collapseToggle = () => container.querySelector('button.nav-collapse') as HTMLButtonElement | null;
const shellEl = () => container.querySelector('.app-shell') as HTMLElement;

beforeEach(() => {
  appState.connected = true;
  window.location.hash = '#/traces';
  installMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  container.remove();
  root = undefined;
});

describe('AppShell', () => {

  it('collapses to a drawer when narrow: toggle, Escape, scrim and link close it', () => {
    stubNarrow(true);
    render();
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle()!.click());
    expect(nav().getAttribute('data-drawer')).toBe('open');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    act(() => toggle()!.click());
    act(() => (container.querySelector('.app-shell-scrim') as HTMLElement).click());
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    act(() => toggle()!.click());
    act(() => (nav().querySelector('a') as HTMLElement).click());
    expect(nav().getAttribute('data-drawer')).toBe('closed');
  });
});

describe('collapsible icon rail', () => {
  it('toggles with aria-expanded and labels, and persists across a remount', () => {
    stubNarrow(false);
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(collapseToggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(collapseToggle()?.getAttribute('aria-label')).toBe('Collapse navigation');
    expect(collapseToggle()?.getAttribute('aria-controls')).toBe('primary-nav');
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    expect(shellEl().getAttribute('data-nav')).toBe('collapsed');
    expect(collapseToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(collapseToggle()?.getAttribute('aria-label')).toBe('Expand navigation');
    expect(window.localStorage.getItem('forge.nav.collapsed')).toBe('1');

    act(() => root?.unmount());
    container.remove();
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(window.localStorage.getItem('forge.nav.collapsed')).toBe('0');
  });

  it('survives storage that throws', () => {
    stubNarrow(false);
    breakStorage();
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
  });
});
