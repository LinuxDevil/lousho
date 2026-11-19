import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatus, McpConnectorStatus } from '../../../shared/profileWire';

const client = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  verifyConnector: vi.fn(),
  connectConnector: vi.fn(),
  disconnectConnector: vi.fn(),
  listMcpConnectors: vi.fn(),
  connectMcpConnector: vi.fn(),
  verifyMcpConnector: vi.fn(),
  removeMcpConnector: vi.fn(),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: client }));

import { ConnectorsTab } from './ConnectorsTab';
import { ToastProvider } from '../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function render(statuses: ConnectorStatus[], mcp: McpConnectorStatus[] = []) {
  client.listConnectors.mockResolvedValue(statuses);
  client.listMcpConnectors.mockResolvedValue(mcp);
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

describe('MCP connectors section', () => {
  const mcpRow = (name: string) => rowOf(name);
  const press = async (label: string) => {
    const button = [...document.querySelectorAll('button')].filter((b) => b.textContent === label).pop()!;
    await act(async () => button.click());
  };
  const type = async (placeholderOrLabel: string, value: string) => {
    const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === placeholderOrLabel)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('shows verified and failed rows', async () => {
    await render([], [
      { name: 'docs', url: 'https://mcp.example.com/mcp', hasToken: true, connectedAt: days(5), verifiedAt: days(2), toolCount: 4 },
      { name: 'wiki', url: 'https://wiki.example.com/mcp', hasToken: false, connectedAt: days(5), verifiedAt: days(0), error: 'The server did not answer within 10 seconds.', toolCount: 1 },
    ]);
    expect(container.textContent).toContain('Agents use these by default unless their configuration already has a server with the same name.');
    expect(mcpRow('docs').querySelector('.profile-row-meta')?.textContent).toBe('mcp.example.com · 4 tools · verified 2d ago');
    expect(mcpRow('wiki').querySelector('.profile-badge.bad')?.textContent).toBe('Check failed');
    expect(mcpRow('wiki').querySelector('.profile-row-meta')?.textContent).toBe('The server did not answer within 10 seconds.');
  });

  it('re-verifies a row and removes one after confirming', async () => {
    client.verifyMcpConnector.mockResolvedValue({ name: 'docs', url: 'https://mcp.example.com/mcp', hasToken: false, connectedAt: days(5), verifiedAt: days(0), toolCount: 6 });
    client.removeMcpConnector.mockResolvedValue(undefined);
    await render([], [{ name: 'docs', url: 'https://mcp.example.com/mcp', hasToken: false, connectedAt: days(5), verifiedAt: days(2), toolCount: 4 }]);
    const verify = [...mcpRow('docs').querySelectorAll('button')].find((b) => b.textContent === 'Verify')!;
    await act(async () => verify.click());
    expect(client.verifyMcpConnector).toHaveBeenCalledWith('docs');
    expect(mcpRow('docs').querySelector('.profile-row-meta')?.textContent).toBe('mcp.example.com · 6 tools · verified just now');
    const remove = [...mcpRow('docs').querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => remove.click());
    expect(client.removeMcpConnector).not.toHaveBeenCalled();
    await press('Remove');
    expect(client.removeMcpConnector).toHaveBeenCalledWith('docs');
  });

  it('validates the name and URL before adding', async () => {
    client.connectMcpConnector.mockResolvedValue({ name: 'docs', url: 'https://mcp.example.com/mcp', hasToken: false, connectedAt: days(0), verifiedAt: days(0), toolCount: 2 });
    await render([], []);
    await press('Add MCP server');
    await type('docs', 'Bad Name');
    await type('https://mcp.example.com/mcp', 'http://example.com');
    await press('Check and add');
    expect(client.connectMcpConnector).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Use 1-32 lowercase letters, digits or dashes');
    expect(document.body.textContent).toContain('The URL must start with https://');
    await type('docs', 'docs');
    await type('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp');
    await press('Check and add');
    expect(client.connectMcpConnector).toHaveBeenCalledWith('docs', { url: 'https://mcp.example.com/mcp' });
    expect(mcpRow('docs').querySelector('.profile-row-meta')?.textContent).toContain('2 tools');
  });
});
