import { describe, it, expect, vi } from 'vitest';
import { ObserveClient } from '../observeClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clientWith(fetchFn: typeof fetch): ObserveClient {
  return new ObserveClient({ baseUrl: '/observe', fetchFn });
}

describe('ObserveClient', () => {

  it('health() answers the health body only for a real lousho-observe marker', async () => {
    const real = clientWith((async () => jsonResponse(200, { service: 'lousho-observe', ok: true, version: '1' })) as typeof fetch);
    expect(await real.health()).toMatchObject({ service: 'lousho-observe' });
    const squatter = clientWith((async () => jsonResponse(200, { service: 'something-else', ok: true })) as typeof fetch);
    expect(await squatter.health()).toBeUndefined();
    const down = clientWith((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(await down.health()).toBeUndefined();
  });

  it('sends the studio token only on the same-origin proxy base', async () => {
    window.sessionStorage.setItem('lousho-studio-token', 'tok-123');
    try {
      const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
        void init;
        return jsonResponse(200, { agents: [] });
      });
      const sameOrigin = new ObserveClient({ baseUrl: '/observe', fetchFn: fetchFn as typeof fetch });
      await sameOrigin.listAgents();
      const headers = new Headers((fetchFn.mock.calls[0][1] as RequestInit).headers);
      expect(headers.get('x-lousho-studio-token')).toBe('tok-123');

      const remote = new ObserveClient({ baseUrl: 'https://collector.example', fetchFn: fetchFn as typeof fetch });
      await remote.listAgents();
      const remoteHeaders = new Headers((fetchFn.mock.calls[1][1] as RequestInit).headers);
      expect(remoteHeaders.get('x-lousho-studio-token')).toBeNull();
    } finally {
      window.sessionStorage.removeItem('lousho-studio-token');
    }
  });
});
