import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { parseHash } from '../../../../router/router';
import { render } from '../../../../ui/__tests__/render';
import { ToastProvider } from '../../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  specToCode: vi.fn(() => 'line1\nline2'),
  specToAgentDir: vi.fn(() => ({
    files: [
      { path: 'agent.yaml', content: 'name: x' },
      { path: 'prompts/system.md', content: 'Hi' },
    ],
    dropped: [],
  })),
}));

// The Code tab calls the real SDK generators in the browser; here they are
// stubbed so the assertions are about the tab, not the generators.
vi.mock('lousho/spec', () => ({
  specToCode: () => mocks.specToCode(),
  specToAgentDir: () => mocks.specToAgentDir(),
}));

// The Serve card (X02b) loads `/agents/:id/serve` on mount and subscribes
// to `/events`; the tab's assertions are about the code views, so both are
// stubbed to an unpublished, disabled status.
vi.mock('../../../../runtime/runtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../runtime/runtimeClient')>();
  return {
    ...actual,
    runtimeClient: {
      getServe: vi.fn(async () => ({
        agentId: 'support-bot',
        enabled: false,
        allowedOrigins: [],
        publishedVersion: null,
        tokenMasked: 'tok…tok',
        baseUrl: '/serve/support-bot',
      })),
      putServe: vi.fn(),
      serveToken: vi.fn(),
      rotateServeToken: vi.fn(),
      ejectAgent: vi.fn(),
    },
  };
});

vi.mock('../../../../state/useStudioEvents', () => ({
  useStudioEvents: () => {},
}));

import { AgentDetailContext } from '../../AgentDetailContext';
import { CodeTab } from '../CodeTab';
import { runtimeClient, RuntimeApiError } from '../../../../runtime/runtimeClient';

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    } as AgentSpecV2,
    meta: {
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
      createdAt: '2026-10-29T09:00:00Z',
      updatedAt: '2026-10-29T09:00:00Z',
    },
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    requirements: [],
  };
}

/** Mounts the tab at `#/agents/support-bot/code` inside the context and toast provider the route provides. */
function renderTab(hash = '/#/agents/support-bot/code') {
  window.history.replaceState(null, '', hash);
  return render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh: () => {}, setRecord: () => {} }}>
        <CodeTab />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
}

/** Flushes the hashchange-triggered re-render: jsdom delivers `hashchange` on a macrotask, so promises alone do not reach `useRoute`. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Clicks the `.seg-btn` whose text is `label` and flushes the hashchange update. */
async function clickView(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.seg-btn')].find((b) => b.textContent === label)!;
  act(() => button.click());
  await flush();
}

/** The treeitem button of the row named `name`. */
function treeItem(host: HTMLElement, name: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('.code-tree-item')].find((b) => b.textContent === name)!;
}

function keydown(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  mocks.specToCode.mockReset().mockReturnValue('line1\nline2');
  mocks.specToAgentDir.mockReset().mockReturnValue({
    files: [
      { path: 'agent.yaml', content: 'name: x' },
      { path: 'prompts/system.md', content: 'Hi' },
    ],
    dropped: [],
  });
});

describe('CodeTab', () => {

  it('Copy writes exactly the generated text and toasts "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = renderTab();
    await flush();

    const copyButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Copy'),
    )!;
    act(() => copyButton.click());
    await flush();

    expect(writeText).toHaveBeenCalledWith('line1\nline2');
    expect(host.querySelector('.toast-message')?.textContent).toBe('Copied');
  });

  it('directory view: ArrowDown moves focus, Enter selects the file into ?file=', async () => {
    const host = renderTab();
    await flush();
    await clickView(host, 'Agent directory');

    // The first tree item (the 'prompts' directory, folders sort first) is the roving-tabindex stop.
    const first = host.querySelector<HTMLButtonElement>('.code-tree-item')!;
    expect(first.textContent).toBe('prompts');
    expect(first.tabIndex).toBe(0);

    keydown(first, 'ArrowDown');
    const systemMd = treeItem(host, 'system.md');
    expect(host.ownerDocument.activeElement).toBe(systemMd);
    expect(systemMd.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    keydown(systemMd, 'Enter');
    await flush();

    expect(parseHash(window.location.hash).query.get('file')).toBe('prompts/system.md');
    expect(host.querySelector('pre.code-view-file')?.textContent).toBe('Hi');
    expect(systemMd.closest('li')?.getAttribute('aria-selected')).toBe('true');
  });

  it('a generator error shows "Could not generate code" and only breaks that view', async () => {
    mocks.specToCode.mockImplementation(() => {
      throw new Error('Unsupported field: flow');
    });
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe('Could not generate code');
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe('Unsupported field: flow');
    // The read-only note is still visible.
    expect(host.querySelector('.code-note')?.textContent).toContain('Read-only');

    await clickView(host, 'YAML');
    expect(host.querySelector('pre.code-view')?.textContent).toContain('name: Support bot');
    expect(host.querySelector('.empty-state-title')).toBeNull();
  });

  it('Eject to project opens the dialog with the generated file count and posts on confirm', async () => {
    const eject = vi.spyOn(runtimeClient, 'ejectAgent').mockResolvedValue({ dir: 'agents/support-bot', files: ['agent.yaml'] });
    const host = renderTab();
    await flush();

    const ejectButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Eject to project'),
    )!;
    act(() => ejectButton.click());
    await flush();

    const dialog = document.querySelector<HTMLElement>('.dialog, [role="dialog"], [role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Writes 2 files to agents/support-bot/');

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Eject'),
    )!;
    act(() => confirm.click());
    await flush();

    expect(eject).toHaveBeenCalledWith('support-bot', false);
    expect(dialog.isConnected).toBe(false);
    expect(host.querySelector('.toast-message')?.textContent).toBe('Ejected to agents/support-bot/');
    eject.mockRestore();
  });

  it('a 409 LOUSHO_EJECT_EXISTS shows the overwrite checkbox and resends with overwrite', async () => {
    const err = new RuntimeApiError('agents/support-bot/ already exists.', 409, 'LOUSHO_EJECT_EXISTS', {
      files: ['agent.yaml', 'prompts/system.md'],
    });
    const eject = vi
      .spyOn(runtimeClient, 'ejectAgent')
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ dir: 'agents/support-bot', files: ['agent.yaml'] });
    const host = renderTab();
    await flush();

    const ejectButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Eject to project'),
    )!;
    act(() => ejectButton.click());
    await flush();

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim() === 'Eject',
    )!;
    act(() => confirm.click());
    await flush();

    expect(eject).toHaveBeenLastCalledWith('support-bot', false);
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(document.body.textContent).toContain('agents/support-bot/ already exists.');

    act(() => {
      checkbox.click();
    });
    await flush();
    const confirmAgain = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim() === 'Eject',
    )!;
    act(() => confirmAgain.click());
    await flush();

    expect(eject).toHaveBeenLastCalledWith('support-bot', true);
    eject.mockRestore();
  });
});
