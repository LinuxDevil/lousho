import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionRecord, RunListRow } from '../../../../shared/wireTypes';

const client = vi.hoisted(() => ({
  listRuns: vi.fn<[], Promise<RunListRow[]>>(),
  loadChatSession: vi.fn<[string, string], Promise<ChatSessionRecord>>(),
  status: vi.fn(async () => ({ status: 'idle' })),
  abort: vi.fn(async () => ({})),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('../../../runtime/runtimeClient', () => {
  class RuntimeApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
  const bound = { loadChatSession: client.loadChatSession, status: client.status, abort: client.abort, subscribe: client.subscribe };
  return { RuntimeApiError, runtimeClient: { listRuns: client.listRuns, forWorkspace: () => bound } };
});

import { RuntimeApiError } from '../../../runtime/runtimeClient';
import { ToastProvider } from '../../../ui/Toast';
import { RunsScreen } from '../RunsScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (patch: Partial<RunListRow>): RunListRow => ({
  workspaceId: 'w-1',
  workspaceName: 'W',
  agentId: 'ops',
  agentName: 'Ops',
  chatId: 'c1',
  status: 'ok',
  live: false,
  turns: 2,
  preview: 'first words',
  lastMessage: 'last words',
  startTime: Date.now() - 60_000,
  lastActivity: Date.now() - 30_000,
  ...patch,
});

const ROWS: RunListRow[] = [
  run({ chatId: 'c1', agentName: 'Ops' }),
  run({ chatId: 'c2', agentName: 'Billing', agentId: 'billing', live: true, status: 'running', source: 'trigger', triggerId: 'nightly', bypass: true }),
  run({ chatId: 'c3', agentName: 'Support', agentId: 'support', status: 'error', traceId: 'tr-9' }),
];

const record = (patch: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId: 'c1',
  startedAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:01:00.000Z',
  messageCount: 2,
  preview: 'Close stale issues',
  setup: { accounts: [{ integration: 'github', tools: ['list_issues'], approvals: [] }], declared: [], mcpServers: [], skipped: [] },
  messages: [
    { id: 'u', role: 'user', content: 'Close stale issues', timestamp: '2026-01-01T10:00:01.000Z', source: 'run' },
    {
      id: 'a',
      role: 'assistant',
      content: 'Listing them.',
      timestamp: '2026-01-01T10:00:02.000Z',
      toolCalls: [{ id: 't', type: 'function', function: { name: 'list_issues', arguments: '{"state":"open"}' } }],
    },
    { id: 'r', role: 'tool', content: '{"issues":[1]}', toolCallId: 't', toolName: 'list_issues', timestamp: '2026-01-01T10:00:03.000Z' },
  ],
  ...patch,
});

let root: Root | undefined;
let container: HTMLDivElement;

async function render(hash: string) {
  window.location.hash = hash;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <RunsScreen />
      </ToastProvider>
    );
  });
  await act(async () => {});
}

const text = () => container.textContent ?? '';
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
  });
const chip = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('.runs-chip')].find((b) => b.textContent?.startsWith(name))!;

beforeEach(() => {
  client.listRuns.mockReset();
  client.loadChatSession.mockReset();
  client.loadChatSession.mockResolvedValue(record());
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

describe('RunsScreen list', () => {
  it('shows filter chips with counts and rows that read as a sentence', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/runs');
    expect([...container.querySelectorAll('.runs-chip')].map((b) => b.textContent)).toEqual(['All 3', 'Live 1', 'Failed 1']);
    const rows = [...container.querySelectorAll('.runs-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Ops');
    expect(rows[0].textContent).toContain('manual · 2 turns');
    expect(rows[0].textContent).toContain('last words');
    expect(rows[1].textContent).toContain('nightly · 2 turns');
    expect(rows[1].querySelector('.pill, [class*="pill"]')).not.toBeNull();
    expect(rows[0].getAttribute('href')).toBe('#/w/w-1/runs/ops/c1');
  });

  it('filters by chip', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/runs');
    await click(chip('Live'));
    expect([...container.querySelectorAll('.runs-row-agent')].map((n) => n.textContent)).toEqual(['Billing']);
    expect(chip('Live').getAttribute('aria-pressed')).toBe('true');
    await click(chip('Failed'));
    expect([...container.querySelectorAll('.runs-row-agent')].map((n) => n.textContent)).toEqual(['Support']);
  });

  it('shows the empty state when there are no runs', async () => {
    client.listRuns.mockResolvedValue([]);
    await render('#/runs');
    expect(text()).toContain('No runs yet');
    expect(text()).toContain('one row per chat');
  });

  it('shows an error with Retry, and loads on retry', async () => {
    client.listRuns.mockRejectedValueOnce(new Error('boom'));
    await render('#/runs');
    expect(text()).toContain('Could not load runs');
    expect(text()).toContain('boom');
    client.listRuns.mockResolvedValue(ROWS);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!);
    expect(container.querySelectorAll('.runs-row')).toHaveLength(3);
  });

  it('shows skeletons while the first load is pending', async () => {
    client.listRuns.mockReturnValue(new Promise(() => {}));
    await render('#/runs');
    expect(container.querySelector('.runs-rows-skeleton')).not.toBeNull();
  });

  it('selects the first run at a wide width', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
    await render('#/runs');
    expect(window.location.hash).toBe('#/w/w-1/runs/ops/c1');
  });

  it('keeps the list alone at a narrow width', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/runs');
    expect(window.location.hash).toBe('#/runs');
    expect(container.querySelector('.runs-detail-pane')).toBeNull();
  });
});

describe('RunsScreen detail', () => {
  it('shows the header, the Setup row, the user input and the closing row', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/w/w-1/runs/ops/c1');
    expect(container.querySelector('.run-title')?.textContent).toBe('Ops');
    expect(container.querySelector('.run-title a')?.getAttribute('href')).toBe('#/w/w-1/agents/ops/canvas');
    expect(text()).toContain('Open chat');
    expect(container.querySelector('.run-id code')?.textContent).toBe('c1');
    const titles = [...container.querySelectorAll('.run-step-title, .tool-call-name')].map((n) => n.textContent);
    expect(titles[0]).toMatch(/^Setup · 1 connected account \(github\)/);
    expect(titles).toContain('Run started');
    expect(titles).toContain('list_issues');
    expect(titles.at(-1)).toBe('Finished');
    expect(text()).toContain('Close stale issues');
  });

  it('expands a row on click', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/w/w-1/runs/ops/c1');
    const setup = container.querySelector<HTMLButtonElement>('.run-step-toggle')!;
    expect(setup.getAttribute('aria-expanded')).toBe('false');
    await click(setup);
    expect(setup.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.run-setup-detail')?.textContent).toContain('github: list_issues');
    const tool = container.querySelector<HTMLButtonElement>('.tool-call-toggle')!;
    await click(tool);
    expect(container.querySelector('.tool-call-body')?.textContent).toContain('"state": "open"');
    expect(container.querySelector('.tool-call-body')?.textContent).toContain('"issues"');
  });

  it('clips a long tool result behind a show-all control', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    const long = record();
    long.messages[2] = { ...long.messages[2], content: 'y'.repeat(3000) };
    client.loadChatSession.mockResolvedValue(long);
    await render('#/w/w-1/runs/ops/c1');
    await click(container.querySelector('.tool-call-toggle')!);
    const mono = () => container.querySelectorAll('.run-mono')[1].textContent!.length;
    expect(mono()).toBeLessThan(700);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!);
    expect(mono()).toBe(3000);
  });

  it('omits the Setup row when the chat recorded none', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    client.loadChatSession.mockResolvedValue(record({ setup: undefined }));
    await render('#/w/w-1/runs/ops/c1');
    expect(text()).not.toContain('Setup ·');
  });

  it('treats a chat with no saved transcript as an empty run', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    client.loadChatSession.mockRejectedValue(new RuntimeApiError('none', 404));
    await render('#/w/w-1/runs/ops/c1');
    expect(container.querySelector('.run-timeline')).not.toBeNull();
    expect(text()).toContain('Finished');
  });

  it('offers Stop for a live run and the trace link when there is a trace', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/w/w-1/runs/billing/c2');
    const stop = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!;
    expect(stop).toBeDefined();
    expect(container.querySelector('.run-timeline')?.textContent).toContain('Running…');
    await click(stop);
    expect(client.abort).toHaveBeenCalledWith('billing', 'Stopped from the Runs screen');

    act(() => root?.unmount());
    container.remove();
    await render('#/w/w-1/runs/support/c3');
    expect(container.querySelector('a[href="#/traces/tr-9"]')?.textContent).toContain('Open trace');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(false);
  });

  it('says so when the URL names a run that does not exist', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    await render('#/w/w-1/runs/ops/gone');
    expect(text()).toContain('This run no longer exists');
    expect(container.querySelector('a[href="#/runs"]')).not.toBeNull();
  });

  it('shows an error with Retry when the transcript cannot load', async () => {
    client.listRuns.mockResolvedValue(ROWS);
    client.loadChatSession.mockRejectedValueOnce(new Error('disk gone'));
    await render('#/w/w-1/runs/ops/c1');
    expect(text()).toContain('Could not load this run');
    client.loadChatSession.mockResolvedValue(record());
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!);
    expect(container.querySelector('.run-timeline')).not.toBeNull();
  });
});
