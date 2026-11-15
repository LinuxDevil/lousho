/**
 * `POST /chat` for a session another process or replica is running a turn of
 * (it holds the session's run lease): `409` with `Retry-After` and a coded body,
 * the same answer a channel gives, before any stream starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { fileStore } from '../storage/fileStore';
import { createRouteHandler } from './routeHandler';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const post = (body: unknown, key?: string) =>
  new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key !== undefined && { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  });

/** Two "replicas" over one directory: `a` holds a turn open on session `s1` until `release()`. */
function replicas() {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-chat-busy-'));
  dirs.push(dir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const a = createRouteHandler(
    createAgent({
      provider: mockModel([async () => (await gate, 'A done')]),
      store: fileStore(dir),
    }),
    { basePath: '/api' }
  );
  const b = createRouteHandler(createAgent({ provider: mockModel(['B hello'], { onExhausted: 'repeat-last' }), store: fileStore(dir) }), { basePath: '/api' });
  return { a: a.handler, b: b.handler, release };
}

describe('POST /chat when another replica runs the session', () => {

  it('answers an Idempotency-Key resend the same way while the original turn still runs elsewhere', async () => {
    const { a, b, release } = replicas();
    const first = await a(post({ sessionId: 's2', input: 'hi' }, 'req-1'));
    const firstText = first.text();

    const resend = await b(post({ sessionId: 's2', input: 'hi' }, 'req-1'));
    expect(resend.status).toBe(409);
    expect(resend.headers.get('retry-after')).toBe('2');
    expect(await resend.json()).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });

    release();
    await firstText;
    // The client retries as told and gets the finished turn replayed.
    const retry = await b(post({ sessionId: 's2', input: 'hi' }, 'req-1'));
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(await retry.text()).toContain('A done');
  });
});
