import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConfluenceTools } from './confluence';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('ConfluenceTools', () => {
  const tools = createConfluenceTools({ baseUrl: 'https://acme.atlassian.net/', email: 'a@b.c', apiToken: 't' });
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps plain text in a CQL text query', async () => {
    fetchSpy.mockResolvedValueOnce(json({
      totalSize: 1,
      results: [{ title: 'Runbook', url: '/spaces/OPS/pages/1', content: { id: '1', type: 'page', space: { key: 'OPS' } } }],
    }));
    const execute = getToolExecute(tools.get('confluence_search')!)!;
    const result = JSON.parse(await execute({ query: 'deploy "prod"', cql: false, limit: 5 }, ctx) as string);

    const url = new URL(fetchSpy.mock.calls[0][0]);
    expect(url.pathname).toBe('/wiki/rest/api/search');
    expect(url.searchParams.get('cql')).toBe('text ~ "deploy \\"prod\\""');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('a@b.c:t').toString('base64')}`);
    expect(result.results[0]).toMatchObject({ id: '1', title: 'Runbook', spaceKey: 'OPS', url: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/1' });
  });

  it('passes raw CQL through unchanged', async () => {
    fetchSpy.mockResolvedValueOnce(json({ results: [] }));
    const execute = getToolExecute(tools.get('confluence_search')!)!;
    await execute({ query: 'space = OPS AND type = page', cql: true, limit: 25 }, ctx);
    expect(new URL(fetchSpy.mock.calls[0][0]).searchParams.get('cql')).toBe('space = OPS AND type = page');
  });

  it('increments the current version on update', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ id: '42', title: 'Old', status: 'current', spaceId: '9', version: { number: 7 }, body: { storage: { value: '<p>old</p>' } } }))
      .mockResolvedValueOnce(json({ id: '42', title: 'Old', status: 'current', spaceId: '9', version: { number: 8 } }));
    const execute = getToolExecute(tools.get('confluence_update_page')!)!;
    const result = JSON.parse(await execute({ pageId: '42', body: 'a & b', bodyFormat: 'plain' }, ctx) as string);

    expect(fetchSpy.mock.calls[0][0]).toBe('https://acme.atlassian.net/wiki/api/v2/pages/42?body-format=storage');
    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toBe('https://acme.atlassian.net/wiki/api/v2/pages/42');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body);
    expect(sent.version.number).toBe(8);
    expect(sent.title).toBe('Old');
    expect(sent.body).toEqual({ representation: 'storage', value: '<p>a &amp; b</p>' });
    expect(result.version).toBe(8);
  });

  it('returns a plain-text version of the page body', async () => {
    fetchSpy.mockResolvedValueOnce(json({ id: '1', title: 'T', status: 'current', spaceId: '9', version: { number: 1 }, body: { storage: { value: '<h1>Title</h1><p>Hello &amp; bye</p>' } } }));
    const execute = getToolExecute(tools.get('confluence_get_page')!)!;
    const result = JSON.parse(await execute({ pageId: '1' }, ctx) as string);
    expect(result.text).toBe('Title\nHello & bye');
  });
});
