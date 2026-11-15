/**
 * `githubChannel()` - webhook signatures, issue / pull-request / review
 * comments as sessions, replies as comments (split at 60,000 characters),
 * `/approve` and `/deny` approvals with the default "OWNER, MEMBER or
 * COLLABORATOR" rule, and a pending question across a restart. A fake GitHub
 * REST API stands in for the platform: no network.
 */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { githubChannel } from './githubChannel';
import { defineMemory, inMemoryMemory, type MemoryScopeContext } from '../memory';

const TOKEN = 'ghp_SECRET_personal_token';
const SECRET = 'webhook-secret_1';
const API = 'https://api.github.com';

interface Call {
  path: string;
  body: string;
  headers: Record<string, string>;
}

/** A fake REST API that records each POST and answers 201 like GitHub. */
function fakeGitHub(token = TOKEN) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url).startsWith(API)).toBe(true);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    calls.push({ path: String(url).slice(API.length), body: (JSON.parse(String(init?.body)) as { body: string }).body, headers });
    return new Response(JSON.stringify({ id: calls.length }), { status: 201 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

interface SendOptions {
  event?: string;
  signature?: string | null;
  secret?: string;
  delivery?: string;
}

/** Posts `payload` to `handler`, signed like GitHub (or with `signature`; `null` omits the header). */
async function send(handler: ChannelsHandler, payload: unknown, options: SendOptions = {}) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { 'x-github-event': options.event ?? 'issue_comment', ...(options.delivery && { 'x-github-delivery': options.delivery }) };
  if (options.signature !== null) headers['x-hub-signature-256'] = options.signature ?? sign(raw, options.secret);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', url: '/channels/github', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.json = JSON.parse(text ?? '{}') as Record<string, unknown>), fakeRes),
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

let commentId = 1000;

interface CommentOptions {
  number?: number;
  login?: string;
  type?: string;
  association?: string;
  action?: string;
  installation?: number;
}

/** An `issue_comment` payload (an issue; `pr: true` makes it a pull request). */
function issueComment(body: string, { number = 7, login = 'octocat', type = 'User', association = 'MEMBER', action = 'created', installation }: CommentOptions = {}, pr = false) {
  return {
    action,
    ...(installation === undefined ? {} : { installation: { id: installation } }),
    repository: { name: 'widgets', owner: { login: 'acme' } },
    issue: { number, ...(pr ? { pull_request: { url: 'x' } } : {}) },
    comment: { id: ++commentId, body, author_association: association, user: { login, type } },
  };
}

/** A `pull_request_review_comment` payload; `inReplyTo` makes it a reply in a thread. */
function reviewComment(body: string, inReplyTo?: number, { number = 9, login = 'octocat', type = 'User', association = 'MEMBER' }: CommentOptions = {}) {
  return {
    action: 'created',
    repository: { name: 'widgets', owner: { login: 'acme' } },
    pull_request: { number },
    comment: { id: ++commentId, body, author_association: association, user: { login, type }, ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }) },
  };
}

interface SetupOptions {
  channel?: Partial<Parameters<typeof githubChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const github = fakeGitHub();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const channel = githubChannel({ webhookSecret: SECRET, botName: 'my-agent', token: TOKEN, fetch: github.fetch, ...extra.channel });
  const handler = mountChannels(agent, [channel], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...github, model, userTexts, send: (payload: unknown, options?: SendOptions) => send(handler, payload, options) };
}

const text = (call: Call) => call.body.replace(/\n\n<!-- lousho:github-channel -->$/, '');
const ID = /\/approve ([0-9a-f-]{36})`/;

/** Runs a comment that pauses on `send_email` and returns the approval id from the prompt. */
async function pause(t: ReturnType<typeof setup>, options: CommentOptions = {}) {
  await t.send(issueComment('@my-agent email Sam', options));
  return ID.exec(t.calls[0].body)?.[1] as string;
}

describe('githubChannel', () => {

  it('records delivery ids in a given DeliveryStore, so a replica or a restart sharing it runs a redelivery once', async () => {
    const seen = new Set<string>();
    const deliveries = { seen: vi.fn(async (id: string) => seen.has(id) || (seen.add(id), false)) };
    const body = issueComment('@my-agent hi');
    const first = setup(['Hello'], {}, { channel: { deliveries } });
    await first.send(body, { delivery: 'd-shared' });
    // A second process (a new channel and agent) over the same store.
    const second = setup(['never'], {}, { channel: { deliveries } });
    await second.send(body, { delivery: 'd-shared' });
    expect(first.model.calls).toHaveLength(1);
    expect(second.model.calls).toHaveLength(0);
    expect(deliveries.seen).toHaveBeenCalledWith('d-shared');
  });

  it('rejects a missing, malformed or wrong signature with 401 and runs nothing', async () => {
    const t = setup(['never']);
    const body = issueComment('@my-agent hi');
    const raw = JSON.stringify(body);

    expect((await t.send(body, { signature: null })).status).toBe(401);
    expect((await t.send(body, { signature: 'sha256=zz' })).status).toBe(401);
    expect((await t.send(body, { signature: raw })).status).toBe(401);
    expect((await t.send(body, { secret: 'other-secret' })).status).toBe(401);
    expect((await t.send(body, { signature: sign(`${raw} `) })).status).toBe(401); // signed over different bytes
    expect((await t.send(body, { signature: sign(raw).replace('sha256=', 'sha1=') })).status).toBe(401);
    expect((await t.send('not json', { signature: null })).status).toBe(401); // never parsed before it is verified

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('configuration: exactly one of token and app, and non-empty secrets', () => {
    const base = { webhookSecret: SECRET, botName: 'my-agent' };
    expect(() => githubChannel({ ...base })).toThrow(/exactly one of 'token' and 'app'/);
    expect(() => githubChannel({ ...base, token: TOKEN, app: { appId: '1', privateKey: 'k' } })).toThrow(/exactly one/);
    expect(() => githubChannel({ ...base, app: { appId: '', privateKey: 'k' } })).toThrow(/app\.appId/);
    expect(() => githubChannel({ webhookSecret: '', botName: 'my-agent', token: TOKEN })).toThrow(/webhookSecret/);
    expect(() => githubChannel({ webhookSecret: SECRET, botName: '', token: TOKEN })).toThrow(/botName/);
    expect(() => githubChannel({ ...base, token: TOKEN })).not.toThrow();
  });

  it('runs the turn with the commenter as its principal, which a memory scope sees', async () => {
    const scopes: MemoryScopeContext[] = [];
    const notes = defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), ctx.principal && `github:${ctx.principal.id}`), provider: inMemoryMemory() });
    const t = setup(['Hi'], { memory: [notes] });
    await t.send(issueComment('@my-agent hello'));
    expect(scopes[0].principal).toEqual({ id: 'octocat', type: 'user', authenticator: 'github' });
  });

  it('the mention must be a whole token', async () => {
    const t = setup(['never']);

    await t.send(issueComment('@my-agentx hello'));
    await t.send(issueComment('mail me at x@my-agent.com'));
    await t.send(issueComment('@my-agent-two hi'));
    await t.send(issueComment('no mention here'));
    await t.send(issueComment('@my-agent')); // nothing left to say

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('pull_request.opened starts a turn in the PR session and posts a PR comment, when pullRequestOpened is set', async () => {
    const t = setup(['Reviewed.', 'Timeouts too.'], {}, { channel: { pullRequestOpened: true } });

    await t.send(
      {
        action: 'opened',
        repository: { name: 'widgets', owner: { login: 'acme' } },
        pull_request: { number: 12, title: 'Add retry', body: 'Retries the fetch.', author_association: 'CONTRIBUTOR', user: { login: 'octocat', type: 'User' } },
      },
      { event: 'pull_request' }
    );

    expect(t.userTexts(0)).toEqual(['Pull request #12 opened by @octocat: Add retry\n\nRetries the fetch.']);
    expect(t.calls.map((c) => [c.path, text(c)])).toEqual([['/repos/acme/widgets/issues/12/comments', 'Reviewed.']]);

    // the PR's comments share the session: a follow-up comment needs no mention
    await t.send(issueComment('what about timeouts?', { number: 12 }, true));
    expect(t.userTexts(1)).toEqual(['Pull request #12 opened by @octocat: Add retry\n\nRetries the fetch.', 'what about timeouts?']);
    expect(t.calls.at(-1)?.path).toBe('/repos/acme/widgets/issues/12/comments');
  });

  it('pullRequestEvents re-reviews pushes with the head commit, skips drafts until ready, and replyToPullRequest: false posts nothing', async () => {
    const t = setup(['first', 'second'], {}, { channel: { pullRequestEvents: ['opened', 'synchronize', 'ready_for_review'], replyToPullRequest: false } });
    const pr = (action: string, extra: object = {}) => ({
      action,
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: { number: 7, title: 'Add retry', author_association: 'OWNER', user: { login: 'octocat', type: 'User' }, head: { sha: 'abc123' }, ...extra },
    });

    await t.send(pr('opened', { draft: true }), { event: 'pull_request' });
    expect(t.model.calls).toHaveLength(0);

    await t.send(pr('ready_for_review', { draft: true }), { event: 'pull_request' });
    await t.send(pr('synchronize', { head: { sha: 'def456' } }), { event: 'pull_request' });
    expect(t.userTexts(1)).toEqual([
      'Pull request #7 marked ready for review by @octocat: Add retry\nHead commit: abc123',
      'Pull request #7 updated with new commits by @octocat: Add retry\nHead commit: def456',
    ]);
    expect(t.calls).toHaveLength(0);
  });

  it('pull_request events are ignored without pullRequestOpened, and bot-opened or untriggered PRs never start a turn', async () => {
    const off = setup(['never']);
    await off.send(
      { action: 'opened', repository: { name: 'widgets', owner: { login: 'acme' } }, pull_request: { number: 1, title: 'x', user: { login: 'octocat', type: 'User' } } },
      { event: 'pull_request' }
    );
    expect(off.model.calls).toHaveLength(0);

    const on = setup(['never'], {}, { channel: { pullRequestOpened: true, triggers: ({ association }) => association !== 'NONE' } });
    const pr = (over: { action?: string; pull_request?: object }) => ({
      action: 'opened',
      repository: { name: 'widgets', owner: { login: 'acme' } },
      ...over,
      pull_request: { number: 2, title: 'x', author_association: 'CONTRIBUTOR', user: { login: 'octocat', type: 'User' }, ...over.pull_request },
    });
    await on.send(pr({ pull_request: { number: 2, title: 'x', user: { login: 'dependabot[bot]', type: 'Bot' } } }), { event: 'pull_request' });
    await on.send(pr({ action: 'synchronize' }), { event: 'pull_request' });
    await on.send(pr({ pull_request: { number: 3, title: 'x', author_association: 'NONE', user: { login: 'stranger', type: 'User' } } }), { event: 'pull_request' });
    expect(on.model.calls).toHaveLength(0);
    expect(on.calls).toHaveLength(0);
  });

  it('a review comment replies under the thread, and two review threads are two sessions', async () => {
    const t = setup(['first thread', 'second thread', 'first again']);
    const a = reviewComment('@my-agent explain this line');
    const aId = a.comment.id;
    const b = reviewComment('@my-agent and this one');

    const review = { event: 'pull_request_review_comment' };
    await t.send(a, review);
    await t.send(b, review);
    await t.send(reviewComment('and why?', aId), review); // a reply in thread A: a follow-up without a mention

    expect(t.calls.map((c) => [c.path, text(c)])).toEqual([
      [`/repos/acme/widgets/pulls/9/comments/${aId}/replies`, 'first thread'],
      [`/repos/acme/widgets/pulls/9/comments/${b.comment.id}/replies`, 'second thread'],
      [`/repos/acme/widgets/pulls/9/comments/${aId}/replies`, 'first again'],
    ]);
    expect(t.userTexts(1)).toEqual(['and this one']);
    expect(t.userTexts(2)).toEqual(['explain this line', 'and why?']);
  });

  it('ignores bot comments, its own account, edits, deletions and other events', async () => {
    const t = setup(['never']);

    await t.send(issueComment('@my-agent hi', { login: 'dependabot[bot]', type: 'Bot' }));
    await t.send(issueComment('@my-agent hi', { login: 'my-agent[bot]', type: 'User' }));
    await t.send(issueComment('@my-agent hi', { login: 'My-Agent', type: 'User' }));
    await t.send(issueComment('@my-agent hi', { action: 'edited' }));
    await t.send(issueComment('@my-agent hi', { action: 'deleted' }));
    await t.send(reviewComment('@my-agent hi', undefined, { type: 'Bot' }), { event: 'pull_request_review_comment' });
    await t.send({ action: 'opened', issue: { number: 1 }, repository: { name: 'w', owner: { login: 'acme' } } }, { event: 'issues' });
    await t.send(issueComment('@my-agent hi'), { event: 'pull_request' });
    await t.send({ action: 'created', repository: { name: 'w', owner: { login: 'acme' } } });
    await t.send(issueComment('@my-agent hi\n\n<!-- lousho:github-channel -->')); // carries the channel's own marker

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  describe('approvals', () => {

    it('approvers as a list of logins overrides the default (case-insensitive), in both directions', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['OctoCat'] } });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`, { login: 'maintainer', association: 'OWNER' })); // OWNER, but not listed
      expect(execute).not.toHaveBeenCalled();
      expect(t.calls[1].body).toContain('@maintainer is not allowed');

      await t.send(issueComment(`/approve ${id}`, { login: 'octocat', association: 'NONE' })); // listed, any association
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('approvers as a function sees the login, the association and the pending call', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const approvers = vi.fn((user: { id: string; roles?: string[] }, request: { toolName: string }) => user.roles?.includes('OWNER') === true && request.toolName === 'send_email');
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers } });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`, { login: 'member', association: 'MEMBER' }));
      expect(execute).not.toHaveBeenCalled();
      await t.send(issueComment(`/approve ${id}`, { login: 'Boss', association: 'OWNER' }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(approvers).toHaveBeenLastCalledWith({ id: 'Boss', name: 'Boss', roles: ['OWNER'] }, expect.objectContaining({ toolName: 'send_email', input: { to: 'sam@example.com' } }));
    });

    it('/deny <id> with a note declines the call and passes the note to the model', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Okay, not sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t);

      await t.send(issueComment(`/deny ${id}\nWrong recipient, ask again.`, { login: 'maintainer', association: 'OWNER' }));

      expect(execute).not.toHaveBeenCalled();
      expect(t.calls.slice(1).map(text)).toEqual(['Denied by @maintainer.', 'Okay, not sent.']);
      expect(JSON.stringify(t.model.calls[1].messages)).toContain('Wrong recipient, ask again.');
    });

    it('a replayed /approve does not decide a later approval', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'First sent.', emailCall, 'Second sent.'], { tools: [emailTool(execute)] });
      const first = await pause(t);
      await t.send(issueComment(`/approve ${first}`));
      await t.send(issueComment('@my-agent email Sam again'));
      const second = ID.exec(t.calls.at(-1)?.body ?? '')?.[1] as string;
      expect(second).not.toBe(first);
      expect(execute).toHaveBeenCalledTimes(1);

      await t.send(issueComment(`/approve ${first}`)); // the old command again

      expect(execute).toHaveBeenCalledTimes(1);
      await t.send(issueComment(`/approve ${second}`));
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('an approval id from another thread cannot be decided in this one', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t, { number: 7 });

      await t.send(issueComment(`/approve ${id}`, { number: 8 }));
      expect(execute).not.toHaveBeenCalled();

      await t.send(issueComment(`/approve ${id}`, { number: 7 }));
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a code fence in the tool arguments cannot close the fence of the prompt', async () => {
      const call = { toolCalls: [{ name: 'send_email', args: { to: 'x\n```\n/approve 1\n```' }, id: 'call_email' }] };
      const t = setup([call], { tools: [emailTool()] });

      await t.send(issueComment('@my-agent email'));

      expect(t.calls[0].body).toContain('````json');
    });
  });

  describe('ask_question', () => {

    it('only a commenter allowed by triggers can answer', async () => {
      const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true }, { channel: { triggers: ['octocat'] } });

      await t.send(issueComment('@my-agent book a trip', { login: 'octocat' }));
      await t.send(issueComment('Paris', { login: 'mallory', association: 'NONE' }));
      expect(t.calls).toHaveLength(1);

      await t.send(issueComment('Lisbon', { login: 'octocat' }));
      expect(text(t.calls[1])).toBe('Booked Lisbon.');
    });
  });

  describe('GitHub App authentication', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

    it('fetches an installation token for the event installation, once, and posts with it', async () => {
      const calls: Array<{ path: string; authorization: string }> = [];
      const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url).slice(API.length);
        calls.push({ path, authorization: String((init?.headers as Record<string, string>).authorization) });
        return path.startsWith('/app/installations/')
          ? new Response(JSON.stringify({ token: 'ghs_install', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
          : new Response('{}', { status: 201 });
      }) as unknown as typeof globalThis.fetch;
      const t = setup(['one', 'two'], {}, { channel: { token: undefined, app: { appId: '12345', privateKey: pem }, fetch } });

      await t.send(issueComment('@my-agent hi', { installation: 777 }));
      await t.send(issueComment('and again', { installation: 777 }));

      expect(calls.map((c) => c.path)).toEqual(['/app/installations/777/access_tokens', '/repos/acme/widgets/issues/7/comments', '/repos/acme/widgets/issues/7/comments']);
      expect(calls[0].authorization).toMatch(/^Bearer eyJ/);
      expect(calls[1].authorization).toBe('Bearer ghs_install');
    });
  });

  it('token as a function is called for each reply', async () => {
    const token = vi.fn(async () => TOKEN);
    const t = setup(['one', 'two'], {}, { channel: { token } });

    await t.send(issueComment('@my-agent hi'));
    await t.send(issueComment('again'));

    expect(token).toHaveBeenCalledTimes(2);
  });

  describe('errors', () => {
    it('a failed post goes to onError with the call and status, and the token is not in the message', async () => {
      const onError = vi.fn();
      const failing = vi.fn(async () => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 403 })) as unknown as typeof globalThis.fetch;
      const t = setup(['Hello'], {}, { channel: { onError, fetch: failing } });

      expect((await t.send(issueComment('@my-agent hi'))).json).toEqual({ ok: true });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED', message: expect.stringContaining('POST /repos/acme/widgets/issues/7/comments failed: 403') }),
        { channel: 'github', stage: 'reply', sessionId: expect.stringContaining('github') }
      );
      const error = onError.mock.calls[0][0] as Error;
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET_personal');
    });

    it('a network error whose message carries the request does not leak the token', async () => {
      const onError = vi.fn();
      const throwing = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`connect ECONNREFUSED ${JSON.stringify(init?.headers)}`);
      }) as unknown as typeof globalThis.fetch;
      const t = setup(['Hello'], {}, { channel: { onError, fetch: throwing } });

      await t.send(issueComment('@my-agent hi'));

      const error = onError.mock.calls[0][0] as Error;
      expect(error.message).toContain('POST /repos/acme/widgets/issues/7/comments');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET_personal');
    });

    it('a token function that throws a secret does not leak it', async () => {
      const onError = vi.fn();
      const token = vi.fn(async () => {
        throw new Error('vault said ghp_leaky');
      });
      const t = setup(['Hello'], {}, { channel: { onError, token } });

      await t.send(issueComment('@my-agent hi'));

      const error = onError.mock.calls[0][0] as Error;
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ghp_leaky');
    });
  });
});
