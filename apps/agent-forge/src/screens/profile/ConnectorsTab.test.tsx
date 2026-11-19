import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatus } from '../../../shared/profileWire';

const client = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  verifyConnector: vi.fn(),
  connectConnector: vi.fn(),
  disconnectConnector: vi.fn(),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: client }));

import { ConnectorsTab } from './ConnectorsTab';
import { ToastProvider } from '../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function render(statuses: ConnectorStatus[]) {
  client.listConnectors.mockResolvedValue(statuses);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(ConnectorsTab))));
}

const rowOf = (label: string) => [...container.querySelectorAll('.profile-row')].find((r) => r.querySelector('.profile-row-title')?.textContent?.startsWith(label))!;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe('ConnectorsTab identity', () => {
  it('shows the account and when it was verified', async () => {
    await render([{ id: 'github', connected: true, filled: ['token'], account: 'LinuxDevil', verifiedAt: days(3) }]);
    const row = rowOf('GitHub');
    expect(row.querySelector('.profile-row-title')?.textContent).toBe('GitHubConnected');
    expect(row.querySelector('.profile-row-meta')?.textContent).toBe('LinuxDevil · verified 3d ago');
  });

  it('shows the provider message when the last check failed', async () => {
    await render([{ id: 'github', connected: true, filled: ['token'], verifiedAt: days(0), error: 'GitHub answered 401: Bad credentials' }]);
    const row = rowOf('GitHub');
    expect(row.querySelector('.profile-badge.bad')?.textContent).toBe('Check failed');
    expect(row.querySelector('.profile-row-meta')?.textContent).toBe('GitHub answered 401: Bad credentials');
  });

  it('re-verifies from the row and updates it', async () => {
    client.verifyConnector.mockResolvedValue({ id: 'github', connected: true, filled: ['token'], account: 'octo', verifiedAt: days(0) });
    await render([{ id: 'github', connected: true, filled: ['token'], account: 'old', verifiedAt: days(3) }]);
    const verify = [...rowOf('GitHub').querySelectorAll('button')].find((b) => b.textContent === 'Verify')!;
    await act(async () => verify.click());
    expect(client.verifyConnector).toHaveBeenCalledWith('github');
    expect(rowOf('GitHub').querySelector('.profile-row-meta')?.textContent).toBe('octo · verified just now');
  });

  it('offers Verify for Email and not for Google', async () => {
    await render([
      { id: 'email', connected: true, filled: ['apiKey'], account: 'a@example.com', verifiedAt: days(1) },
      { id: 'google', connected: true, filled: ['clientId'], connectedAt: days(1) },
    ]);
    const labels = (name: string) => [...rowOf(name).querySelectorAll('button')].map((b) => b.textContent);
    expect(labels('Email')).toContain('Verify');
    expect(labels('Google')).not.toContain('Verify');
  });
});
