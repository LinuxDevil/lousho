import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createAgentRunner } from '../ui/agentRunner';
import { initialAgentUIState, reduceAgentEvents, type AgentUIState } from '../ui/reducer';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import { defineMemory, inMemoryMemory, type MemoryScopeContext } from '../memory';
import type { RunConfigContext } from '../createAgent';
import { AuthError, apiToken, basic, jwt, type AuthFn, type Principal } from '../auth';
import { SECRET, hmacKey, signToken } from '../auth/__fixtures__/tokens';

const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'shipped' });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://app.test${path}`, { headers });

async function frames(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map((frame) => JSON.parse(frame.slice(6)));
}

const routes = (replies: Parameters<typeof mockModel>[0], options?: RouteHandlerOptions) =>
  createRouteHandler(createAgent({ provider: mockModel(replies), tools: [deploy], store: memoryStore() }), options);

describe('createRouteHandler', () => {

  describe('a step paused on several calls', () => {
    const release = defineTool({ name: 'release', description: 'Releases', input: z.object({}), needsApproval: true, execute: () => 'released' });
    const twoCalls = { toolCalls: [{ name: 'deploy', id: 'c1' }, { name: 'release', id: 'c2' }] };

    it('each approval is decided through the route, in any order; the last runs the step', async () => {
      const { handler } = createRouteHandler(createAgent({ provider: mockModel([twoCalls, 'Both done.']), tools: [deploy, release], store: memoryStore() }));
      const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 'm1', input: 'ship and release' })));
      const ids = paused.filter((e) => e.type === 'approval.requested').map((e) => e.approvalId as string);
      expect(ids).toHaveLength(2);

      const partial = await frames(await handler(post(`/api/agent/chat/m1/approvals/${ids[1]}`, { approved: true })));
      expect(partial.find((e) => e.type === 'tool.done')).toBeUndefined();
      expect(partial.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'awaiting-approval' });

      const done = await frames(await handler(post(`/api/agent/chat/m1/approvals/${ids[0]}`, { approved: true })));
      expect(done.filter((e) => e.type === 'tool.done').map((e) => e.result)).toEqual(['shipped', 'released']);
      expect(done.at(-1)).toMatchObject({ finishReason: 'stop', text: 'Both done.' });
    });
  });

  it('asks an authorizer function, sync or async', async () => {
    const seen: string[] = [];
    const { handler } = routes(['ok', 'ok'], {
      auth: async (request) => {
        seen.push(request.method);
        return request.headers.get('x-user') === 'ada';
      },
    });
    const body = { sessionId: 's4', input: 'hi' };
    expect((await handler(post('/api/agent/chat', body))).status).toBe(401);
    expect((await handler(post('/api/agent/chat', body, { 'x-user': 'ada' }))).status).toBe(200);
    expect(seen).toEqual(['POST', 'POST']);
  });

  describe('auth lists', () => {
    const scopes: MemoryScopeContext[] = [];
    const seen: Array<Principal | undefined> = [];
    const agentWithPrincipal = (replies: string[]) =>
      createAgent({
        provider: mockModel(replies),
        store: memoryStore(),
        instructions: ({ principal }: RunConfigContext) => (seen.push(principal), `You serve ${principal?.id ?? 'nobody'}.`),
        memory: [defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), ctx.principal && `user:${ctx.principal.issuer ?? ''}:${ctx.principal.id}`), provider: inMemoryMemory() })],
      });

    it('runs the list in order and hands the accepted principal to instructions and memory scopes', async () => {
      seen.length = 0;
      scopes.length = 0;
      const hs = await hmacKey();
      const { handler } = createRouteHandler(agentWithPrincipal(['one', 'two']), {
        auth: [jwt({ secret: SECRET, issuer: 'https://iss.test', audience: 'agent' }), apiToken('ci-token', { id: 'ci' })],
      });
      const token = await signToken(hs, { sub: 'ada', iss: 'https://iss.test', aud: 'agent' });
      for (const [sessionId, authorization] of [['p1', `Bearer ${token}`], ['p2', 'Bearer ci-token']]) {
        const response = await handler(post('/api/agent/chat', { sessionId, input: 'hi' }, { authorization }));
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(seen.map((p) => [p?.authenticator, p?.id, p?.issuer])).toEqual([
        ['jwt', 'ada', 'https://iss.test'],
        ['api-token', 'ci', undefined],
      ]);
      expect(scopes.map((ctx) => ctx.principal?.id)).toEqual(['ada', 'ci']);
      expect(scopes[0]).toMatchObject({ sessionId: 'p1', principal: { claims: expect.objectContaining({ aud: 'agent' }) } });
    });

    it('answers 401 with every challenge when nothing matches, 403 for AuthError(403), and leaves /health open', async () => {
      const forbidden = () => {
        throw new AuthError(403);
      };
      const { handler } = createRouteHandler(agentWithPrincipal(['x']), { auth: [apiToken('t'), basic({ users: { a: 'b' } })] });
      const denied = await handler(post('/api/agent/chat', { sessionId: 'p3', input: 'hi' }));
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toBe('Bearer, Basic realm="lousho", charset="UTF-8"');
      expect(await denied.json()).toEqual({ error: 'Unauthorized' });
      expect(await (await handler(get('/api/agent/health'))).text()).toBe('ok');
      const { handler: closed } = createRouteHandler(agentWithPrincipal(['x']), { auth: [forbidden] });
      expect((await closed(get('/api/agent/chat/p3'))).status).toBe(403);
      expect(await (await closed(get('/api/agent/health'))).text()).toBe('ok');
    });

    it('the useChat endpoint and the useLoushoAgent route run with the principal too', async () => {
      seen.length = 0;
      const { handler } = createRouteHandler(agentWithPrincipal(['a', 'b']), { auth: apiToken('t', { id: 'web' }), uiMessageStream: true });
      const headers = { authorization: 'Bearer t' };
      await (await handler(post('/api/agent/ui', { id: 'u1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, headers))).text();
      await (await handler(post('/api/agent', { input: 'hi' }, headers))).text();
      expect(seen.map((p) => p?.id)).toEqual(['web', 'web']);
    });
  });

  it('strips the base path, accepts a trailing slash, and 404s outside it', async () => {
    const { handler } = routes(['a', 'b'], { basePath: '/v1/bot/' });
    expect((await handler(post('/v1/bot/chat/', { sessionId: 's5', input: 'hi' }))).status).toBe(200);
    expect((await handler(get('/v1/bot/chat/s5'))).status).toBe(200);
    expect((await handler(post('/api/agent/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(post('/v1/botany/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(get('/v1/bot/nope'))).status).toBe(404);
  });

  describe('session ownership and approval decisions', () => {
    /** `Bearer u-<id>` authenticates the user principal `{ id, type: 'user', authenticator: 'test' }`. */
    const userAuth: AuthFn = async (request) => {
      const id = /^Bearer u-(.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return id === undefined ? null : { id, type: 'user', authenticator: 'test' };
    };
    const as = (user: string) => ({ authorization: `Bearer u-${user}` });
    const authed = (replies: Parameters<typeof mockModel>[0], options?: RouteHandlerOptions) =>
      createRouteHandler(createAgent({ provider: mockModel(replies), tools: [deploy], store: memoryStore() }), { auth: [userAuth], ...options });

    it('the caller the paused run acts for decides it; another caller gets 403', async () => {
      const { handler } = authed([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
      const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 'g1', input: 'ship it' }, as('alice'))));
      const { approvalId } = paused.find((e) => e.type === 'approval.requested') as { approvalId: string };
      const other = await handler(post(`/api/agent/chat/g1/approvals/${approvalId}`, { approved: true }, as('staff')));
      expect(other.status).toBe(403);
      const own = await frames(await handler(post(`/api/agent/chat/g1/approvals/${approvalId}`, { approved: true }, as('alice'))));
      expect(own.find((e) => e.type === 'tool.done')).toMatchObject({ result: 'shipped' });
    });
  });

  it('serves the remote createAgentRunner behind useLoushoAgent({ url, approvalsUrl }) unchanged, approvals included', async () => {
    const { handler } = routes([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
    let state: AgentUIState = initialAgentUIState;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(`http://app.test${String(input)}`, init))) as typeof fetch;
    const runner = createAgentRunner({
      source: () => ({ url: '/api/agent', fetch: fetchImpl }),
      options: () => ({ approvalsUrl: '/api/agent/approvals' }),
      state: () => state,
      dispatch: (action) => {
        state = reduceAgentEvents(state, action);
      },
    });
    await runner.send('ship it');
    expect(state.pendingApproval).toMatchObject({ toolName: 'deploy' });
    await runner.approve();
    expect(state.pendingApproval).toBeNull();
    expect(JSON.stringify(state.messages.at(-1))).toContain('Deployed.');
  });

  describe('uiMessageStream', () => {
    const userMessage = (text: string) => ({ id: 'm', role: 'user', parts: [{ type: 'text', text }] });

    it('answers 400 for an invalid chat id, like POST /chat, before authorizeSession sees it', async () => {
      const authorizeSession = vi.fn(() => true);
      const { handler } = routes(['ok'], { uiMessageStream: true, authorizeSession });
      const ui = await handler(post('/api/agent/ui', { id: 'bad/id!', messages: [userMessage('hi')] }));
      const chat = await handler(post('/api/agent/chat', { sessionId: 'bad/id!', input: 'hi' }));
      expect([ui.status, chat.status]).toEqual([400, 400]);
      expect((await ui.json()).error).toMatch(/Invalid session id/);
      expect(authorizeSession).not.toHaveBeenCalled();
    });
  });
});
