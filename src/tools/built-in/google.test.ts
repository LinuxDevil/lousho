import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGoogleWorkspaceTools, type GoogleWorkspaceTools } from './google';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Forbidden' });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'access-1', expires_in: 3600 });
}

describe('GoogleWorkspaceTools', () => {
  let tools: GoogleWorkspaceTools;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const run = async (name: string, args: unknown): Promise<unknown> => {
    const execute = getToolExecute(tools.get(name)!);
    return JSON.parse((await execute!(args, ctx)) as string);
  };

  beforeEach(() => {
    tools = createGoogleWorkspaceTools({ clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes the access token once and reuses it across tool calls', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }));

    await run('drive_search_files', { q: "name contains 'a'" });
    await run('drive_search_files', { q: "name contains 'b'" });

    const tokenCalls = fetchSpy.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token');
    expect(tokenCalls).toHaveLength(1);
    const body = new URLSearchParams(tokenCalls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('secret');
    expect(fetchSpy.mock.calls[2][1].headers.Authorization).toBe('Bearer access-1');
  });

  it('searches Drive files with the query', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'f1', name: 'Report', mimeType: 'text/plain' }] }));

    const result = await run('drive_search_files', { q: "name contains 'Report'", pageSize: 5 });

    const url = new URL(fetchSpy.mock.calls[1][0] as string);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(url.searchParams.get('q')).toBe("name contains 'Report'");
    expect(url.searchParams.get('pageSize')).toBe('5');
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer access-1');
    expect(result).toEqual({ files: [{ id: 'f1', name: 'Report', mimeType: 'text/plain' }] });
  });

  it('sends Gmail email as a base64url RFC 2822 message', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({ id: 'm1', threadId: 't1' }));

    const result = await run('gmail_send_email', {
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
      subject: 'Hello',
      body: 'Hi there?>',
    });

    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(init.method).toBe('POST');
    const raw = JSON.parse(init.body as string).raw as string;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const message = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = message.split('\r\n\r\n');
    expect(head).toContain('To: alice@example.com, bob@example.com');
    expect(head).toContain('Cc: carol@example.com');
    expect(head).toContain('Subject: Hello');
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Hi there?>');
    expect(result).toEqual({ id: 'm1', threadId: 't1' });
  });

  it('reads a Sheets range', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['1', '2']] }));

    const result = await run('sheets_read_range', { spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' });

    expect(fetchSpy.mock.calls[1][0]).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/${encodeURIComponent('Sheet1!A1:B2')}`,
    );
    expect(result).toEqual({ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['1', '2']] });
  });

  it('surfaces HTTP errors', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Insufficient Permission' } }, 403));

    await expect(run('sheets_read_range', { spreadsheetId: 's', range: 'A1' })).rejects.toThrow(
      /Failed to read sheet range: Forbidden - .*Insufficient Permission/,
    );
  });
});
