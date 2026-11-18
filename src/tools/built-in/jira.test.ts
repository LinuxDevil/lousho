import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJiraTools } from './jira';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('JiraTools extras', () => {
  const tools = createJiraTools({ baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', apiToken: 't' });
  const run = (name: string, args: Record<string, unknown>) => getToolExecute(tools.get(name)!)!(args, ctx);
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the changelog into history entries', async () => {
    fetchSpy.mockResolvedValueOnce(json({
      total: 1,
      isLast: true,
      values: [{
        id: '100',
        created: '2026-01-01T00:00:00.000+0000',
        author: { displayName: 'Ada' },
        items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
      }],
    }));
    const result = JSON.parse(await run('jira_get_ticket_history', { ticketKey: 'PROJ-1', startAt: 0, maxResults: 50 }) as string);

    expect(fetchSpy.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/changelog?startAt=0&maxResults=50');
    expect(result.history).toEqual([{
      id: '100',
      author: 'Ada',
      created: '2026-01-01T00:00:00.000+0000',
      changes: [{ field: 'status', from: 'To Do', to: 'In Progress' }],
    }]);
  });

  it('lists fields with schema type and filters custom ones', async () => {
    const fields = [
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
      { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number' } },
    ];
    fetchSpy.mockResolvedValueOnce(json(fields)).mockResolvedValueOnce(json(fields));

    const all = JSON.parse(await run('jira_list_fields', { customOnly: false }) as string);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/field');
    expect(all.fields).toEqual([
      { id: 'summary', name: 'Summary', custom: false, type: 'string' },
      { id: 'customfield_10016', name: 'Story Points', custom: true, type: 'number' },
    ]);

    const custom = JSON.parse(await run('jira_list_fields', { customOnly: true }) as string);
    expect(custom.fields.map((f: { id: string }) => f.id)).toEqual(['customfield_10016']);
  });
});
