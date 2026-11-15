/**
 * `ctx.getToken()` pauses the run until the user signs in. A fake OAuth
 * token endpoint (a `fetch` fake) and `mockModel` drive every flow offline:
 * pause, callback, resume; refresh; `requireAuth`; principal and app
 * credentials; declining; approval and sign-in together; the result safety net.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import type { AgentEvent, AgentEventOf } from '../execution/agentEvents';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { defineOAuthProvider } from './defineOAuthProvider';
import { completeSignIn, redactHandedOutError, startSignIn } from './signIn';
import { MemoryTokenStore } from './memoryTokenStore';
import { ALICE, BOB, fakeOAuthServer, githubProvider, listReposTool, type FakeOAuthServer } from './__fixtures__/fakeOAuth';
import type { TokenOwner } from './types';

afterEach(() => { vi.restoreAllMocks(); });

const ALICE_OWNER: TokenOwner = { owner: 'user', principalId: 'alice', issuer: 'https://id.example.com' };
const CALL = { toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] };

function script(final = 'You have lousho-demo and agent-sdk.') {
  return mockModel([CALL, { text: final }]);
}

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

function toolMessage(result: ExecutionResult): Record<string, unknown> {
  const message = result.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1');
  return JSON.parse(String(message?.content)) as Record<string, unknown>;
}

function setup(server: FakeOAuthServer = fakeOAuthServer(), options: Parameters<typeof listReposTool>[1] = {}, final?: string) {
  const github = githubProvider(server);
  const { tool, executions } = listReposTool(github, options);
  const store = memoryStore();
  const agent = createAgent({ provider: script(final), tools: [tool], store });
  return { server, github, executions, store, agent };
}

describe('ctx.getToken(): pause until sign-in', () => {

  it('a state works once, for 10 minutes, and only for the user it was made for', async () => {
    const { agent } = setup();
    const paused = await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const state = stateOf(pending.signIn?.url ?? '');

    await expect(agent.oauth.complete({ state, code: 'code-bob', principal: BOB })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
    await expect(agent.oauth.complete({ state: 'x'.repeat(43), code: 'code-alice' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
    // Bob's refused attempt did not burn Alice's link
    await expect(agent.oauth.complete({ state, code: 'code-alice', principal: ALICE })).resolves.toMatchObject({ approvalId: paused.approvalId });
    await expect(agent.oauth.complete({ state, code: 'code-alice' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });

    const tokens = new MemoryTokenStore();
    const url = await startSignIn(githubProvider(fakeOAuthServer()), ALICE_OWNER, tokens);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
    await expect(completeSignIn({ state: stateOf(url), code: 'code-alice' }, tokens)).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
  });

  it('a refused code exchange is LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED and never echoes the code or the response body', async () => {
    const { agent } = setup();
    await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const failure: unknown = await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), code: 'stolen-code-123' }).catch((error: unknown) => error);
    if (!(failure instanceof Error)) throw new Error('expected oauth.complete() to reject');
    expect(failure).toMatchObject({ code: 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED' });
    expect(failure.message).toContain('HTTP 400 (invalid_grant)');
    expect(failure.message).not.toContain('stolen-code-123');
  });

  it('declining at the provider cancels the call: approving then gives the model a denied result', async () => {
    const { agent, executions } = setup(undefined, {}, 'Okay, I will not list them.');
    const paused = await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const declined = await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), error: 'access_denied' });
    expect(declined).toMatchObject({ approvalId: paused.approvalId, outcome: 'declined' });

    const resumed = await agent.approvals.resolve({ id: paused.approvalId ?? '', approved: true });
    expect(resumed.finishReason).toBe('stop');
    expect(toolMessage(resumed)).toMatchObject({ kind: 'denied', message: 'Sign-in to GitHub was cancelled.' });
    expect(executions).toEqual([]);
  });

  it('a tool that needs approval and a sign-in: approve, sign in, then one execution and no second approval prompt', async () => {
    const { agent, executions } = setup(undefined, { needsApproval: true });
    const asked: AgentEventOf<'approval.requested'>[] = [];
    const watch = (event: AgentEvent) => void (event.type === 'approval.requested' && asked.push(event));

    const first = await collect(agent.stream('List my repositories.', { principal: ALICE }));
    first.events.forEach(watch);
    expect(asked.map((a) => a.kind)).toEqual([undefined]);

    const second = await collect(agent.approvals.streamResolve({ id: asked[0].approvalId, approved: true }));
    second.events.forEach(watch);
    expect(second.result.finishReason).toBe('awaiting-approval');
    expect(asked.map((a) => a.kind)).toEqual([undefined, 'sign-in']);
    expect(executions).toEqual([]);

    await agent.oauth.complete({ state: stateOf(asked[1].signIn?.url ?? ''), code: 'code-alice' });
    const done = await collect(agent.approvals.streamResolve({ id: asked[1].approvalId, approved: true }));
    done.events.forEach(watch);
    expect(done.result.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
    expect(asked).toHaveLength(2);
  });
});

describe('stored tokens: refresh and requireAuth', () => {
  it('refreshes a token that expires within 60 s, without a pause', async () => {
    const { server, store, agent, executions } = setup();
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_old', refreshToken: 'ghr_SECRET_old', expiresAt: Date.now() + 30_000 });

    const result = await agent.send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_refreshed_1']);
    expect(Object.fromEntries(server.requests[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_SECRET_old', scope: 'repo read:user' });
    // the new token is stored, and keeps the refresh token the server did not replace
    expect(await store.tokens.get('github', ALICE_OWNER)).toMatchObject({ accessToken: 'gho_SECRET_refreshed_1', refreshToken: 'ghr_SECRET_old' });
  });

  it('a failed refresh deletes the token and pauses for sign-in', async () => {
    const server = fakeOAuthServer();
    server.refuseRefresh = true;
    const { store, agent, executions } = setup(server);
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_old', refreshToken: 'ghr_SECRET_old', expiresAt: Date.now() - 1 });

    const result = await agent.send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.list())[0].kind).toBe('sign-in');
    expect(await store.tokens.get('github', ALICE_OWNER)).toBeUndefined();
    expect(executions).toEqual([]);
  });

  it('concurrent refreshes with a rotating refresh token share one request and keep the new token', async () => {
    let live = 'ghr_SECRET_R0';
    let issued = 0;
    const requests: string[] = [];
    const rotating = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const presented = new URLSearchParams(String(init?.body ?? '')).get('refresh_token');
      requests.push(String(presented));
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (presented !== live) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      issued++;
      live = `ghr_SECRET_R${issued}`;
      return new Response(JSON.stringify({ access_token: `gho_SECRET_A${issued}`, refresh_token: live, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const github = githubProvider(fakeOAuthServer(), { fetch: rotating });
    const { tool, executions } = listReposTool(github);
    const store = memoryStore();
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_A0', refreshToken: 'ghr_SECRET_R0', expiresAt: Date.now() + 10_000 });
    const agent = () => createAgent({ provider: script(), tools: [tool], store });

    const results = await Promise.all([agent().send('a', { principal: ALICE, sessionId: 's1' }), agent().send('b', { principal: ALICE, sessionId: 's2' })]);
    expect(results.map((r) => r.finishReason)).toEqual(['stop', 'stop']);
    expect(requests).toEqual(['ghr_SECRET_R0']);
    expect(executions).toEqual(['gho_SECRET_A1', 'gho_SECRET_A1']);
    expect(await store.tokens.get('github', ALICE_OWNER)).toMatchObject({ accessToken: 'gho_SECRET_A1', refreshToken: 'ghr_SECRET_R1' });
  });

  it('a refresh refused because another process already rotated the token uses the stored new token', async () => {
    const store = memoryStore();
    const server = fakeOAuthServer();
    // Another process refreshes first: the server refuses our refresh token, and the store already holds the new one.
    const refused = (async () => {
      await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_other', refreshToken: 'ghr_SECRET_other', expiresAt: Date.now() + 3_600_000 });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as typeof fetch;
    const github = githubProvider(server, { fetch: refused });
    const { tool, executions } = listReposTool(github);
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_old', refreshToken: 'ghr_SECRET_old', expiresAt: Date.now() + 10_000 });
    const result = await createAgent({ provider: script(), tools: [tool], store }).send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_other']);
    expect(await store.tokens.get('github', ALICE_OWNER)).toMatchObject({ accessToken: 'gho_SECRET_other' });
  });

  it('uses a fresh token as is, and an expired one without a refresh token means sign-in', async () => {
    const { server, store, agent, executions } = setup();
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_fresh', expiresAt: Date.now() + 3_600_000 });
    expect((await agent.send('List my repositories.', { principal: ALICE })).finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_fresh']);
    expect(server.requests).toEqual([]);

    const again = setup();
    await again.store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_stale', expiresAt: Date.now() - 1 });
    expect((await again.agent.send('List my repositories.', { principal: ALICE })).finishReason).toBe('awaiting-approval');
  });

  it('requireAuth() after a 401 deletes the token and pauses; after a new sign-in the call succeeds', async () => {
    const revoked = new Set(['gho_SECRET_revoked']);
    const { store, agent, executions } = setup(undefined, { revoked });
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_revoked', expiresAt: Date.now() + 3_600_000 });

    const paused = await agent.send('List my repositories.', { principal: ALICE });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await store.tokens.get('github', ALICE_OWNER)).toBeUndefined();
    expect(executions).toEqual([]);

    const [pending] = await agent.approvals.list();
    await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), code: 'code-alice' });
    expect((await agent.approvals.resolve({ id: pending.id, approved: true })).finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
  });
});

describe('who owns the credential', () => {
  it("a user credential on a run without a principal is a tool error, with no pause", async () => {
    const { agent, executions } = setup(undefined, {}, 'I cannot tell who you are.');
    const { events, result } = await collect(agent.stream('List my repositories.'));
    expect(result.finishReason).toBe('stop');
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(JSON.stringify(toolMessage(result))).toContain('LOUSHO_OAUTH_PRINCIPAL_REQUIRED');
    expect(executions).toEqual([]);
  });

  it("an app credential is never asked of a chat user; the operator's signInUrl() connects it for everyone", async () => {
    const server = fakeOAuthServer();
    const slack = defineOAuthProvider({
      name: 'slack_bot',
      displayName: 'Slack',
      credentialOwner: 'app',
      authorizationUrl: 'https://slack.example.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.example.com/api/oauth.v2.access',
      clientId: 'slack-client',
      clientSecret: 'slack-secret',
      clientAuth: 'client_secret_basic',
      redirectUri: 'https://agent.example.com/oauth/callback',
      fetch: server.fetch,
    });
    const seen: string[] = [];
    const post = defineTool({
      name: 'post_update',
      description: 'Posts to the team channel',
      input: z.object({}),
      execute: async (_args, ctx) => {
        seen.push((await ctx.getToken(slack)).accessToken);
        return 'posted';
      },
    });
    const store = memoryStore();
    const turns = [{ toolCalls: [{ name: 'post_update', id: 'call_1', args: {} }] }, { text: 'Done.' }];
    const agent = createAgent({ provider: mockModel([...turns, ...turns, ...turns, ...turns]), tools: [post], store });

    const before = await collect(agent.stream('Post the update.', { principal: ALICE }));
    expect(before.events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(JSON.stringify(before.events)).not.toContain('code_challenge');
    expect(JSON.stringify(toolMessage(before.result))).toContain('LOUSHO_OAUTH_APP_SIGNIN_REQUIRED');

    const url = await agent.oauth.signInUrl(slack);
    expect(await agent.approvals.list()).toEqual([]);
    expect(await agent.oauth.complete({ state: stateOf(url), code: 'code-app' })).toEqual({ outcome: 'signed-in', provider: 'slack_bot', displayName: 'Slack' });
    // client_secret_basic: the secret is in the header, not the form
    expect(server.headers[0].get('authorization')).toBe(`Basic ${Buffer.from('slack-client:slack-secret').toString('base64')}`);
    expect(server.requests[0].get('client_secret')).toBeNull();

    expect((await agent.send('Post the update.')).finishReason).toBe('stop');
    expect((await agent.send('Post the update.', { principal: ALICE })).finishReason).toBe('stop');
    expect((await agent.send('Post the update.', { principal: BOB })).finishReason).toBe('stop');
    expect(seen).toEqual(['gho_SECRET_app_1', 'gho_SECRET_app_1', 'gho_SECRET_app_1']);
    await expect(agent.oauth.signInUrl(githubProvider(server))).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it('a run without a token store stops with LOUSHO_OAUTH_STORE_MISSING', async () => {
    const github = githubProvider(fakeOAuthServer());
    const { tool } = listReposTool(github);
    const agent = createAgent({ provider: script(), tools: [tool] });
    await expect(agent.send('List my repositories.', { principal: ALICE })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STORE_MISSING' });
    await expect(agent.oauth.complete({ state: 'x'.repeat(43), code: 'c' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STORE_MISSING' });
  });
});

describe('a tool never returns a token', () => {
  it('a result containing a token from getToken() has it replaced with [REDACTED], with a warning naming the tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, agent } = setup(undefined, { returnToken: true });
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_leaky', expiresAt: Date.now() + 3_600_000 });
    const { events, result } = await collect(agent.stream('List my repositories.', { principal: ALICE }));
    expect(toolMessage(result)).toEqual({ repos: ['lousho-demo'], debug: 'token=[REDACTED]' });
    expect(JSON.stringify(events)).not.toContain('gho_SECRET_leaky');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Tool 'list_repos' returned an OAuth token"));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('gho_SECRET_leaky');
  });

  // The shapes a real tool plausibly returns or throws.
  const TOKEN = 'gho_SECRET_shape_123456';
  const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  class Debug { header = `Bearer ${TOKEN}`; }
  const shapes: Record<string, (token: string) => unknown> = {
    'an object key': (token) => ({ [token]: 'scopes: repo' }),
    'a URL instance': (token) => ({ next: new URL(`https://api.example/?access_token=${token}`) }),
    'a class instance': () => new Debug(),
    'a base64 Basic header': (token) => ({ basic: Buffer.from(`x-access-token:${token}`).toString('base64') }),
    'a base64url value': (token) => ({ v: Buffer.from(`ab${token}`).toString('base64url') }),
    'a thrown error': (token) => { throw new Error(`GitHub 401 for Authorization: Bearer ${token}`); },
    'a thrown string': (token) => { throw `Bearer ${token}`; },
  };
  for (const [shape, make] of Object.entries(shapes)) {
    it(`redacts a token in ${shape}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const github = githubProvider(fakeOAuthServer());
      const tool = defineTool({
        name: 'gh',
        description: 'gh',
        input: z.object({}),
        execute: async (_args, ctx) => make((await ctx.getToken(github)).accessToken) as Record<string, unknown>,
      });
      const store = memoryStore();
      await store.tokens.set('github', ALICE_OWNER, { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 });
      const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'gh', id: 'call_1', args: {} }] }, { text: 'ok' }]), tools: [tool], store });
      const { events, result } = await collect(agent.stream('go', { principal: ALICE }));
      const recorded = JSON.stringify(result.messages) + JSON.stringify(events);
      expect(recorded).toContain('[REDACTED]');
      expect(recorded).not.toContain(TOKEN);
      expect(recorded).not.toContain(BASIC.slice(24));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Tool 'gh'"));
    });
  }

  it('redacts the message, stack and cause chain of a thrown error, keeping its identity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const inner = new Error(`token ${TOKEN} refused`);
    const error = Object.assign(new TypeError(`Bearer ${TOKEN}`, { cause: inner }), { code: 'E_GH' });
    const out = redactHandedOutError('gh', error, new Set([TOKEN])) as TypeError & { code: string };
    expect(out).toBe(error);
    expect(out.code).toBe('E_GH');
    expect(out.message).toBe('Bearer [REDACTED]');
    expect(out.stack).not.toContain(TOKEN);
    expect((out.cause as Error).message).toBe('token [REDACTED] refused');
    expect((out.cause as Error).stack).not.toContain(TOKEN);
    // A frozen error cannot be changed: a redacted copy is thrown instead.
    const frozen = Object.freeze(new Error(`Bearer ${TOKEN}`));
    expect((redactHandedOutError('gh', frozen, new Set([TOKEN])) as Error).message).toBe('Bearer [REDACTED]');
    // An error without a token is left alone.
    const clean = new Error('nothing here');
    expect(redactHandedOutError('gh', clean, new Set([TOKEN]))).toBe(clean);
  });
});

describe('defineOAuthProvider', () => {
  it('validates the name, the URLs and the client id', () => {
    const server = fakeOAuthServer();
    expect(() => githubProvider(server, { name: 'git hub' })).toThrow(/`name` must be 1-64 characters/);
    expect(() => githubProvider(server, { tokenUrl: 'not a url' })).toThrow(/`tokenUrl` must be an absolute http\(s\) URL/);
    expect(() => githubProvider(server, { redirectUri: 'javascript:alert(1)' })).toThrow(/`redirectUri`/);
    expect(() => githubProvider(server, { clientId: '' })).toThrow(/`clientId`/);
    expect(() => githubProvider(server, { credentialOwner: 'team' as 'app' })).toThrow(/`credentialOwner`/);
    expect(() => githubProvider(server, { clientAuth: 'jwt' as 'client_secret_post' })).toThrow(/`clientAuth`/);
    const provider = githubProvider(server, { authorizationParams: { prompt: 'consent', state: 'attacker' } });
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider).toMatchObject({ credentialOwner: 'user', clientAuth: 'client_secret_post' });
  });

  it('authorization params cannot replace the state, the challenge or the redirect', async () => {
    const provider = githubProvider(fakeOAuthServer(), { authorizationParams: { prompt: 'consent', state: 'attacker', redirect_uri: 'https://evil.example.com' } });
    const url = new URL(await startSignIn(provider, ALICE_OWNER, new MemoryTokenStore()));
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('redirect_uri')).toBe('https://agent.example.com/api/agent/oauth/callback');
  });
});
