import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/wire.fixtures.json';
import { WorkspaceApiError, createFetchClient, formatRunEventFrame, readRunEvents } from './apiClient';
import type { WireRunEvent } from './wireTypes';

const events = fixtures.responses.streamRunEvents as WireRunEvent[];

const encoder = new TextEncoder();

const noWait = async (): Promise<void> => undefined;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const sse = (list: WireRunEvent[]): Response => new Response(streamOf(list.map(formatRunEventFrame)), { headers: { 'content-type': 'text/event-stream' } });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function collect(source: AsyncIterable<WireRunEvent>): Promise<WireRunEvent[]> {
  const out: WireRunEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function headersOf(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function recorder(answer: (seen: Seen, call: number) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(url),
      method: init?.method,
      headers: headersOf(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    return answer(entry, seen.length - 1);
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

describe('SSE reader', () => {

  it('rejects an event that does not match the wire schema', async () => {
    const bad = `id: 0\ndata: ${JSON.stringify({ id: 0, runId: 'r', event: { type: 'progress' } })}\n\n`;
    await expect(collect(readRunEvents(streamOf([bad])))).rejects.toBeInstanceOf(WorkspaceApiError);
    await expect(collect(readRunEvents(streamOf(['data: {not json\n\n'])))).rejects.toBeInstanceOf(WorkspaceApiError);
  });

  it('reconnects with Last-Event-ID and does not repeat a step', async () => {
    const http = recorder((seen, call) => {
      if (call === 0) return sse(events.slice(0, 3));
      expect(seen.headers['last-event-id']).toBe('2');
      return sse(events.slice(1));
    });
    const client = createFetchClient({ baseUrl: 'https://svc.test/', fetch: http.fetch, sleep: noWait });
    const got = await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001' }));
    expect(got.map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(http.seen).toHaveLength(2);
  });
});

describe('stream failures', () => {
  const frame = (id: number, runId = 'run-0001'): string => formatRunEventFrame({ id, runId, event: { type: 'progress', message: `m${id}` } });
  const finished = (id: number): string => formatRunEventFrame({ id, runId: 'run-0001', event: { type: 'finished', status: 'ok' } });
  const bodyOf = (text: string): Response => new Response(streamOf([text]));
  const open = { workspaceId: 'marketing', runId: 'run-0001' };

  it('fails a frame over 1 MB without retrying', async () => {
    const http = recorder(() => bodyOf(`data: ${'x'.repeat(1024 * 1024 + 10)}`));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch, sleep: noWait });
    await expect(collect(client.streamRunEvents(open))).rejects.toMatchObject({ name: 'WorkspaceApiError', retryable: false });
    expect(http.seen).toHaveLength(1);
  });

  it('wraps a network failure as a retryable status 0 error and retries it', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return bodyOf(frame(0) + finished(1));
    }) as typeof fetch;
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: flaky, sleep: noWait });
    expect((await collect(client.streamRunEvents(open))).map((event) => event.id)).toEqual([0, 1]);
    const down = createFetchClient({ baseUrl: 'https://svc.test', fetch: (async () => Promise.reject(new TypeError('offline'))) as typeof fetch });
    await expect(down.call('listWorkspaces', {})).rejects.toMatchObject({ name: 'WorkspaceApiError', status: 0, retryable: true });
  });

  it('waits with a growing delay and honours a retry: hint', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const dropping = recorder(() => bodyOf(''));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: dropping.fetch, sleep, maxReconnects: 3, reconnectDelayMs: 100 });
    await expect(collect(client.streamRunEvents(open))).rejects.toBeInstanceOf(WorkspaceApiError);
    expect(waits).toEqual([100, 200, 400]);
    const hinted: number[] = [];
    const withHint = recorder((_seen, call) => bodyOf(call === 0 ? 'retry: 1500\n\n' : frame(0) + finished(1)));
    const hintClient = createFetchClient({ baseUrl: 'https://svc.test', fetch: withHint.fetch, sleep: async (ms) => void hinted.push(ms) });
    expect((await collect(hintClient.streamRunEvents(open))).length).toBe(2);
    expect(hinted).toEqual([1500]);
  });
});

describe('createFetchClient', () => {
  it('sends the method, path, body and headers of the route', async () => {
    const http = recorder(() => json({ revision: 'rev-2', problems: [] }));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch, headers: async () => ({ authorization: 'Bearer t', 'x-user': 'signed' }) });
    const result = await client.call('discardDraft', { params: { id: 'marketing', draftId: 'draft-0001' } });
    expect(result).toEqual({ revision: 'rev-2', problems: [] });
    expect(http.seen[0]).toMatchObject({
      url: 'https://svc.test/api/workspaces/marketing/drafts/draft-0001/discard',
      method: 'POST',
      body: undefined,
      headers: { authorization: 'Bearer t', 'x-user': 'signed' },
    });
  });

  it('a stale write throws with the current revision', async () => {
    const http = recorder(() => json({ error: 'stale', currentRevision: 'rev-9' }, 409));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    const failed = client.call('applyDraft', { params: { id: 'marketing', draftId: 'd' }, body: { expectedRevision: 'rev-1' } });
    await expect(failed).rejects.toMatchObject({ name: 'WorkspaceApiError', status: 409, currentRevision: 'rev-9' });
  });

  it('does not trust an answer that breaks the wire contract', async () => {
    const http = recorder(() => json({ id: 'marketing' }));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    await expect(client.call('getWorkspace', { params: { id: 'marketing' } })).rejects.toMatchObject({ status: 502 });
    const html = recorder(() => new Response('<html>', { status: 200 }));
    await expect(createFetchClient({ baseUrl: 'https://svc.test', fetch: html.fetch }).call('listWorkspaces', {})).rejects.toMatchObject({ status: 502 });
  });

  it('a failed answer without a JSON body still throws', async () => {
    const http = recorder(() => new Response('boom', { status: 500 }));
    await expect(createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch }).call('listWorkspaces', {})).rejects.toMatchObject({ status: 500 });
  });
});
