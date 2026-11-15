import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  spec: { version: 2, name: 'demo', model: 'mock/echo', instructions: '' },
  graph: {
    version: 2,
    nodes: [
      { id: 'agent', kind: 'agent', owner: null, position: { x: 0, y: 0 }, data: { fields: { model: 'mock/echo' }, extra: {} } },
    ],
    emptySections: [],
    unplaced: [],
  },
  agentId: 'demo',
  dirty: false,
  runStatus: undefined,
  debugMode: false,
  setDebugMode: () => {},
  setDrawerTab: () => {},
  runAgent: async () => {},
  stopAgent: async () => {},
  save: async () => {},
  setSpec: () => {},
  activeProfile: undefined,
  connected: true,
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

// The off-Agents screens themselves are not under test here, only the frame around them.
vi.mock('../traces/TracesScreen', () => ({ TracesScreen: () => null }));
vi.mock('../monitoring/MonitoringScreen', () => ({ MonitoringScreen: () => null }));

import { Screens, screenFor, useScreen } from '../routes';
import { ROUTES } from '../routeTable';
import { EvalsTabs } from '../evals/EvalsTabs';
import { Topbar } from '../../components/Topbar';
import { ToastProvider } from '../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
}

const buttonNames = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());

beforeEach(() => {
  window.history.replaceState(null, '', '/?token=secret');
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  window.history.replaceState(null, '', '/');
});

describe('screenFor', () => {
  it("gives every route an example path that lands on that route's screen", () => {
    for (const { pattern, screen, example } of ROUTES) {
      expect(example.split('/').length, pattern).toBe(pattern.split('/').length);
      expect(screenFor(`#${example}`), example).toBe(screen);
    }
  });
});

describe('useScreen', () => {
  function probe() {
    const seen: string[] = [];
    const Probe = () => {
      seen.push(useScreen());
      return null;
    };
    render(createElement(Probe));
    return seen;
  }

  it('redirects an empty hash to #/agents with replace, keeping ?token=', () => {
    const before = window.history.length;
    const seen = probe();
    expect(window.location.hash).toBe('#/agents');
    expect(window.location.search).toBe('?token=secret');
    expect(window.history.length).toBe(before);
    expect(seen.every((s) => s === 'agentList')).toBe(true);
  });

  it('redirects the legacy #/agents/:id builder URL to its canvas tab, keeping ?token=', () => {
    window.history.replaceState(null, '', '/?token=secret#/agents/x');
    const before = window.history.length;
    const seen = probe();
    expect(window.location.hash).toBe('#/agents/x/canvas');
    expect(window.location.search).toBe('?token=secret');
    expect(window.history.length).toBe(before);
    expect(seen.every((s) => s === 'agents')).toBe(true);
  });

  it('redirects an unknown route to #/agents, keeping ?token=', () => {
    window.history.replaceState(null, '', '/?token=secret#/nope');
    probe();
    expect(window.location.hash).toBe('#/agents');
    expect(window.location.search).toBe('?token=secret');
  });
});

describe('Topbar', () => {

  // Off Agents the Topbar is not rendered at all: the screen frame carries the shell's ScreenHeader.
  it('has no Build controls or model badge on #/traces', () => {
    window.history.replaceState(null, '', '/?token=secret#/traces');
    render(<Screens />);
    for (const name of ['Run', 'Stop', 'Import', 'Export', 'Save', 'Debug', 'Build', 'Observe']) {
      expect(buttonNames()).not.toContain(name);
    }
    expect(container.querySelector('.env-select')).toBeNull();
    expect(container.querySelector('.mock-badge')).toBeNull();
    expect(container.querySelector('header')?.textContent).toContain('Traces');
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it("maps the old 'Observe surface' shortcut to #/traces", () => {
    window.history.replaceState(null, '', '/?token=secret#/agents/demo/canvas');
    render(<Topbar narrow />);
    act(() => (container.querySelector('[aria-label="More actions"]') as HTMLButtonElement).click());
    const item = [...container.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'Observe surface',
    ) as HTMLButtonElement;
    act(() => item.click());
    expect(window.location.hash).toBe('#/traces');
    expect(window.location.search).toBe('?token=secret');
  });
});

describe('EvalsTabs', () => {
  it('links every Evaluations screen and marks the current one', () => {
    window.history.replaceState(null, '', '/?token=secret#/evals/datasets/golden');
    render(<EvalsTabs />);
    const nav = container.querySelector('nav[aria-label="Evaluations"]')!;
    const links = [...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Scores', '#/evals/scores'],
      ['Datasets', '#/evals/datasets'],
      ['Evaluators', '#/evals/evaluators'],
      ['Annotation queues', '#/evals/queues'],
    ]);
    expect([...nav.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Datasets']);
  });
});
