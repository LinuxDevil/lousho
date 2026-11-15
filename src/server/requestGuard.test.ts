/**
 * Cross-site requests, JSON bodies, `Host` allowlists and the default session
 * owner on the session routes (`createRouteHandler()`, `serveFetch()`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import { handleChatFetch, serveFetch } from './fetchRoutes';
import { claimSession, releaseSession, sessionOwner, setSessionOwnerLimit, setSessionPrincipalLimit } from './requestGuard';
import { MemorySessionStore } from '../session/sessionStore';
import { textOf } from '../providers/content';
import type { AuthFn, Principal } from '../auth';

const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'shipped' });

/** A cookie-style auth: `cookie: user=<name>` is that user. */
const cookieAuth: AuthFn = async (request) => {
  const name = /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
  return name ? { id: name, type: 'user', authenticator: 'custom' } : null;
};

function routes(replies: Parameters<typeof mockModel>[0], options: RouteHandlerOptions = {}) {
  const model = mockModel(replies);
  const agent = createAgent({ provider: model, tools: [deploy], store: memoryStore() });
  return { agent, model, ...createRouteHandler(agent, { auth: [cookieAuth], ...options }) };
}

const post = (path: string, body: string, headers: Record<string, string>) =>
  new Request(`http://app.test/api/agent${path}`, { method: 'POST', headers: { host: 'app.test', ...headers }, body });

const json = (value: unknown) => JSON.stringify(value);
const alice = { cookie: 'user=alice' };
const asJson = { 'content-type': 'application/json' };

describe('cross-site requests (CSRF)', () => {

  it('checks the useChat endpoint as well', async () => {
    const { handler } = routes(['a'], { uiMessageStream: true });
    const body = json({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    expect((await handler(post('/ui', body, { ...alice, ...asJson, origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handler(post('/ui', body, { ...alice, 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handler(post('/ui', body, { ...alice, ...asJson }))).status).toBe(200);
  });
});

describe('allowedHosts', () => {
  it('refuses another Host with 403, but keeps /health open', async () => {
    const { handler } = routes(['a'], { allowedHosts: ['agent.example.com'] });
    const rebound = await handler(post('/chat', json({ sessionId: 'h1', input: 'hi' }), { ...alice, ...asJson, host: 'evil.example' }));
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ code: 'LOUSHO_REQUEST_FORBIDDEN' });
    expect((await handler(new Request('http://evil.example/api/agent/health'))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'h1', input: 'hi' }), { ...alice, ...asJson, host: 'agent.example.com' }))).status).toBe(200);
  });
});

describe('default session owner', () => {

  it('one principal cannot hold every owner slot: past its cap new claims are refused, others are unaffected', () => {
    const agent = {};
    const user = (id: string) => ({ id, type: 'user' as const, authenticator: 'custom' });
    const previousOwner = setSessionOwnerLimit(5);
    const previousPrincipal = setSessionPrincipalLimit(2);
    try {
      // A principal cannot flood the owner map to evict everyone else's records.
      expect(claimSession(agent, 'm1', user('mallory'))).toBe(true);
      expect(claimSession(agent, 'm2', user('mallory'))).toBe(true);
      expect(claimSession(agent, 'm3', user('mallory'))).toBe(false);
      expect(sessionOwner(agent, 'm3')).toBeUndefined();
      expect(claimSession(agent, 'v1', user('alice'))).toBe(true);
      // A released slot is claimable again, and an eviction frees the evicted owner's count too.
      releaseSession(agent, 'm1', user('mallory'));
      expect(claimSession(agent, 'm3', user('mallory'))).toBe(true);
      claimSession(agent, 'v2', user('bob'));
      claimSession(agent, 'v3', user('carol'));
      // The sixth claim evicts 'm2' (least recently used), freeing one of mallory's slots.
      expect(claimSession(agent, 'v4', user('dave'))).toBe(true);
      expect(sessionOwner(agent, 'm2')).toBeUndefined();
      expect(claimSession(agent, 'm4', user('mallory'))).toBe(true);
    } finally {
      setSessionOwnerLimit(previousOwner);
      setSessionPrincipalLimit(previousPrincipal);
    }
  });

  it('evicting an owner past the cap opens the session to nobody, and an empty turn claims nothing', async () => {
    const previous = setSessionOwnerLimit(5);
    try {
      const model = mockModel(['Alice secret: 4242'], { onExhausted: 'repeat-last' });
      const agent = createAgent({ provider: model, store: memoryStore() });
      const { handler } = createRouteHandler(agent, { auth: [cookieAuth], uiMessageStream: true });
      const bob = { cookie: 'user=bob' };
      const uiTurn = (id: string, text?: string) => json({ id, messages: text === undefined ? [] : [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }] });
      await (await handler(post('/chat', json({ sessionId: 'alice-1', input: 'my secret' }), { ...alice, ...asJson }))).text();
      expect((await handler(new Request('http://app.test/api/agent/chat/alice-1', { headers: bob }))).status).toBe(403);

      // An empty turn is refused before anything is claimed or run, so it cannot flood the owner record for free.
      for (let i = 0; i < 20; i++) {
        expect((await handler(post('/chat', json({ sessionId: `empty-${i}`, input: [] }), { ...bob, ...asJson }))).status).toBe(400);
        expect((await handler(post('/ui', uiTurn(`ui-${i}`), { ...bob, ...asJson }))).status).toBe(400);
      }
      expect(model.calls).toHaveLength(1);
      expect(sessionOwner(agent, 'alice-1')).toMatchObject({ id: 'alice' });

      // Real turns past the cap do evict alice's record...
      for (let i = 0; i < 10; i++) await (await handler(post('/chat', json({ sessionId: `flood-${i}`, input: 'x' }), { ...bob, ...asJson }))).text();
      expect(sessionOwner(agent, 'alice-1')).toBeUndefined();

      // ...but a stored session without an owner on record is nobody's to take.
      const read = await handler(new Request('http://app.test/api/agent/chat/alice-1', { headers: bob }));
      expect(read.status).toBe(403);
      expect(await read.text()).not.toContain('secret');
      expect((await handler(post('/chat', json({ sessionId: 'alice-1', input: 'mine now' }), { ...bob, ...asJson }))).status).toBe(403);
      expect((await handler(post('/ui', uiTurn('alice-1', 'mine now'), { ...bob, ...asJson }))).status).toBe(403);
      // It fails closed for alice too: past the cap, ownership needs authorizeSession.
      expect((await handler(new Request('http://app.test/api/agent/chat/alice-1', { headers: alice }))).status).toBe(403);
      expect(sessionOwner(agent, 'alice-1')).toBeUndefined();
      expect(model.calls).toHaveLength(11);
    } finally {
      setSessionOwnerLimit(previous);
    }
  });

  it('a claim lost while a turn ran clears what it stored and ends the stream on a coded error', async () => {
    // With the owner cap at one, a claim on another session evicts 's' while
    // alice's turn is still running; mallory then takes the unowned, still
    // unstored id through the session-less { message } route. Alice's commit
    // must not leave her transcript under mallory's claim.
    const previous = setSessionOwnerLimit(1);
    try {
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const sessions = new MemorySessionStore();
      const store = memoryStore();
      store.sessions = sessions;
      const agent = createAgent({
        provider: mockModel([(req) => (textOf(req.messages.at(-1)!) === 'alice-secret' ? gate.then(() => 'alice-turn') : 'other-turn')], { onExhausted: 'repeat-last' }),
        store,
      });
      const ctx = { name: 'test', agent: () => agent };
      const caller = (id: string): Principal => ({ id, type: 'user', authenticator: 'custom' });
      const post = (body: unknown) => new Request('http://srv/chat', { method: 'POST', headers: asJson, body: json(body) });

      const aliceRes = (await handleChatFetch(post({ sessionId: 's', input: 'alice-secret' }), ctx, caller('alice')))!;
      expect(aliceRes.status).toBe(200);
      const aliceBody = aliceRes.text(); // consuming the SSE is what runs the turn
      await (await handleChatFetch(post({ sessionId: 'x', input: 'evict' }), ctx, caller('alice')))!.text(); // claims 'x', forgetting 's'
      expect(sessionOwner(agent, 's')).toBeUndefined();
      const malloryRes = await handleChatFetch(post({ sessionId: 's', message: 'mallory was here' }), ctx, caller('mallory'));
      expect(malloryRes?.status).toBe(200);
      expect(sessionOwner(agent, 's')).toMatchObject({ id: 'mallory' });

      openGate();
      const body = await aliceBody;
      expect(body).toContain('LOUSHO_SESSION_FORBIDDEN');
      expect(JSON.stringify((await sessions.load('s')) ?? [])).not.toContain('alice-secret');
      expect(sessionOwner(agent, 's')).toMatchObject({ id: 'mallory' });
    } finally {
      setSessionOwnerLimit(previous);
    }
  });

  it('a turn that stores nothing leaves the session unclaimed', async () => {
    // A failure before the run (here the agent's instructions) stores nothing; a provider failure keeps the turn (below).
    let failures = 1;
    const instructions = () => {
      if (failures-- > 0) throw new Error('config down');
      return 'Be brief.';
    };
    const agent = createAgent({ provider: mockModel(['Hi Alice.']), store: memoryStore(), instructions });
    const { handler } = createRouteHandler(agent, { auth: [cookieAuth] });
    const bob = { cookie: 'user=bob' };
    const failed = await handler(post('/chat', json({ sessionId: 'alice-3', input: 'hi' }), { ...bob, ...asJson }));
    expect(await failed.text()).toContain('"type":"error"');
    expect(sessionOwner(agent, 'alice-3')).toBeUndefined();
    await (await handler(post('/chat', json({ sessionId: 'alice-3', input: 'hi' }), { ...alice, ...asJson }))).text();
    expect(sessionOwner(agent, 'alice-3')).toMatchObject({ id: 'alice' });
    expect((await handler(new Request('http://app.test/api/agent/chat/alice-3', { headers: bob }))).status).toBe(403);
  });

  it('after a restart a stored session is refused until authorizeSession says whose it is; one bearer token is one caller', async () => {
    const store = memoryStore();
    const bob = { cookie: 'user=bob' };
    const serve = (options: RouteHandlerOptions) => createRouteHandler(createAgent({ provider: mockModel(['Hi.'], { onExhausted: 'repeat-last' }), store }), options).handler;
    await (await serve({ auth: [cookieAuth] })(post('/chat', json({ sessionId: 'kept', input: 'hi' }), { ...alice, ...asJson }))).text();

    const restarted = serve({ auth: [cookieAuth] });
    expect((await restarted(new Request('http://app.test/api/agent/chat/kept', { headers: alice }))).status).toBe(403);
    expect((await restarted(new Request('http://app.test/api/agent/chat/kept', { headers: bob }))).status).toBe(403);
    expect((await restarted(post('/chat', json({ sessionId: 'kept', input: 'hi' }), { ...bob, ...asJson }))).status).toBe(403);

    const owned = serve({ auth: [cookieAuth], authorizeSession: ({ principal, sessionId }) => sessionId !== 'kept' || principal?.id === 'alice' });
    expect((await owned(new Request('http://app.test/api/agent/chat/kept', { headers: alice }))).status).toBe(200);
    expect((await owned(new Request('http://app.test/api/agent/chat/kept', { headers: bob }))).status).toBe(403);

    const bearer = { authorization: 'Bearer tok' };
    await (await serve({ auth: 'tok' })(post('/chat', json({ sessionId: 'svc', input: 'hi' }), { ...bearer, ...asJson }))).text();
    expect((await serve({ auth: 'tok' })(new Request('http://app.test/api/agent/chat/svc', { headers: bearer }))).status).toBe(200);
    // The generated Worker builds its agent per request: serveFetch() with one token is one caller too.
    const worker = (request: Request) => serveFetch(request, { name: 'worker', agent: () => createAgent({ provider: mockModel(['Hi.']), store }) }, 'tok');
    const read = await worker(new Request('http://app.test/chat/kept', { headers: bearer }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant' }] });
  });
});
