/**
 * `slackChannel()` - signatures, the url_verification handshake, a
 * session per thread, retry dedupe, in-thread replies and approvals as buttons.
 * A fake `fetch` stands in for the Slack Web API: no network.
 */
import { createHmac } from 'node:crypto';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { slackChannel } from './slackChannel';
import { durableStores } from './__fixtures__/durableStores';
import { memoryStore } from '../storage/agentStore';
import { fakeOAuthServer, githubProvider, listReposTool } from '../oauth/__fixtures__/fakeOAuth';

const SECRET = 'slack-signing-secret';
const BOT = 'UBOT';

/** A fake Slack Web API that records each `chat.postMessage` body; `log` interleaves posts and HTTP responses. */
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/1/x';

function fakeSlack() {
  const log: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const callbacks: Array<Record<string, unknown>> = [];
  const ephemerals: Array<Record<string, unknown>> = [];
  const state = { failPosts: false };
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url) === RESPONSE_URL) return callbacks.push(body), new Response('ok');
    if (String(url) === 'https://slack.com/api/chat.postEphemeral') return ephemerals.push(body), new Response(JSON.stringify({ ok: true }));
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test');
    posts.push(body);
    log.push('post');
    return new Response(JSON.stringify(state.failPosts ? { ok: false, error: 'channel_not_found' } : { ok: true }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posts, callbacks, ephemerals, state, log };
}

interface SendOptions {
  form?: boolean;
  headers?: Record<string, string>;
  timestamp?: number;
  secret?: string;
}

/** Posts a signed Slack request (JSON event, or form-encoded interactivity payload) to `handler`. */
async function send(handler: ChannelsHandler, log: string[], payload: unknown, options: SendOptions = {}) {
  const body = options.form ? `payload=${encodeURIComponent(JSON.stringify(payload))}` : JSON.stringify(payload);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', options.secret ?? SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const headers = {
    'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    ...options.headers,
  };
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/channels/slack', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => {
      res.json = JSON.parse(text ?? '{}') as Record<string, unknown>;
      log.push('ack');
      return fakeRes;
    },
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

function event(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    authorizations: [{ user_id: BOT }],
    event: { type: 'app_mention', channel: 'C1', user: 'U1', text: `<@${BOT}> ${text}`, ts: '100.1', ...extra },
  };
}

/** A button click of `user` on the approval message of thread 100.1. */
function click(value: string, user = 'U1', action = 'lousho_approve') {
  return {
    type: 'block_actions',
    user: { id: user, username: `name-${user}` },
    team: { id: 'T1' },
    channel: { id: 'C1' },
    message: { text: 'Approve?', ts: '100.9', thread_ts: '100.1' },
    response_url: RESPONSE_URL,
    actions: [{ action_id: action, value }],
  };
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

interface SetupOptions {
  channel?: Partial<Parameters<typeof slackChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const slack = fakeSlack();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const handler = mountChannels(agent, [slackChannel({ signingSecret: SECRET, botToken: 'xoxb-test', fetch: slack.fetch, ...extra.channel })], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...slack, model, handler, userTexts, send: (payload: unknown, options?: SendOptions) => send(handler, slack.log, payload, options) };
}

describe('slackChannel', () => {
  it('answers the url_verification challenge and rejects bad or stale signatures', async () => {
    const t = setup(['never']);

    expect(await t.send({ type: 'url_verification', challenge: 'abc' })).toEqual({ status: 200, json: { challenge: 'abc' } });
    expect((await t.send(event('hi'), { secret: 'wrong' })).status).toBe(401);
    expect((await t.send(event('hi'), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect((await t.send(event('hi'), { headers: { 'x-slack-signature': 'v0=zz' } })).status).toBe(401);
    expect(t.model.calls).toHaveLength(0);
    expect(() => slackChannel({ signingSecret: '', botToken: 'x' })).toThrow(/signingSecret/);
  });

  it('runs a retry whose event it never saw, and skips a redelivered event_id', async () => {
    const t = setup(['First', 'Lost one']);

    await t.send({ ...event('hi'), event_id: 'Ev1' });
    await t.send({ ...event('hi'), event_id: 'Ev1' }, { headers: { 'x-slack-retry-num': '1' } });
    await t.send({ ...event('hi'), event_id: 'Ev1' });
    expect(t.model.calls).toHaveLength(1);

    // the first delivery of Ev2 never reached this process (a load balancer timed out): the retry is the only copy
    await t.send({ ...event('lost', { ts: '200.1' }), event_id: 'Ev2' }, { headers: { 'x-slack-retry-num': '1' } });
    expect(t.model.calls).toHaveLength(2);
    expect(t.posts.map((p) => p.text)).toEqual(['First', 'Lost one']);
  });

  it('skips retries, bot messages, mention echoes and threads it was never mentioned in', async () => {
    const t = setup(['Once']);

    await t.send(event('hi'));
    expect(await t.send(event('hi'), { headers: { 'x-slack-retry-num': '1' } })).toEqual({ status: 200, json: { ok: true } });
    await t.send(event('x', { type: 'message', text: `<@${BOT}> hi`, ts: '100.1' }));
    await t.send(event('x', { type: 'message', text: 'from me', user: BOT, thread_ts: '100.1', ts: '100.2' }));
    await t.send(event('x', { type: 'message', text: 'beep', bot_id: 'B1', thread_ts: '100.1', ts: '100.3' }));
    await t.send(event('x', { type: 'message', text: 'unrelated', thread_ts: '300.1', ts: '300.2' }));

    expect(t.model.calls).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  /** Runs a turn that pauses on `send_email` and returns the button value of its Approve button. */
  async function pause(t: ReturnType<typeof setup>) {
    await t.send(event('Email Sam'));
    const [prompt] = t.posts as Array<{ blocks: Array<{ elements?: Array<{ value: string }> }> }>;
    return prompt.blocks[1].elements?.[0].value ?? '';
  }

  it('only the user who started the turn may approve by default; others get an ephemeral refusal and it stays pending', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
    const value = await pause(t);

    await t.send(click(value, 'U2'), { form: true });

    expect(execute).not.toHaveBeenCalled();
    expect(t.callbacks).toEqual([{ response_type: 'ephemeral', replace_original: false, text: 'You are not allowed to approve this request.' }]);
    await t.send(click(value, 'U1', 'lousho_deny'), { form: true });
    expect(t.callbacks[1]).toMatchObject({ replace_original: true, text: 'Approve?\nDenied by <@U1>.' });
  });

  it('a failed approval continuation goes to onError; a failing notice never throws out of the handler', async () => {
    const onError = vi.fn();
    const t = setup([emailCall, { error: new Error('model down') }], { tools: [emailTool()] }, { channel: { onError } });
    const value = await pause(t);
    t.state.failPosts = true; // neither the continuation nor the failure notice can be delivered

    expect(await t.send(click(value), { form: true })).toEqual({ status: 200, json: { ok: true } });

    expect(onError.mock.calls.map(([, ctx]) => ctx.stage)).toEqual(['approval', 'reply']);
  });

  it('a direct message to the bot is a session keyed on the DM channel, without a mention', async () => {
    const t = setup(['Hi Ali', 'You are Ali']);
    const dm = (text: string, ts: string) => ({
      type: 'event_callback',
      team_id: 'T1',
      authorizations: [{ user_id: BOT }],
      event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text, ts },
    });

    await t.send(dm('I am Ali', '1.1'));
    await t.send(dm('Who am I?', '2.2'));

    expect(t.posts).toEqual([
      { channel: 'D1', text: 'Hi Ali' },
      { channel: 'D1', text: 'You are Ali' },
    ]);
    expect(t.userTexts(1)).toEqual(['I am Ali', 'Who am I?']);
  });

  describe('after a restart: a second channel over the same durable stores', () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };
    const threadMessage = (text: string, ts: string) => event('x', { type: 'message', text, thread_ts: '100.1', ts });

    it('a pending ask_question survives a restart', async () => {
      const stores = durableStores();
      const agentOptions = { askQuestion: true, approvalStore: stores.approvalStore };
      const first = setup([ask], agentOptions, { mount: { store: stores.store } });
      await first.send(event('Book a trip'));
      expect(first.posts).toEqual([{ channel: 'C1', thread_ts: '100.1', text: expect.stringContaining('Which city?') }]);

      const second = setup(['Booked Lisbon.', 'You are welcome.'], agentOptions, { mount: { store: stores.store } });
      await second.send(threadMessage('Lisbon', '100.2'));

      expect(second.posts).toEqual([{ channel: 'C1', thread_ts: '100.1', text: 'Booked Lisbon.' }]);
      expect(second.model.calls).toHaveLength(1);
      expect(JSON.stringify(second.model.calls[0].messages)).toContain('Lisbon');
      const transcript = await stores.transcript();
      for (const text of ['Book a trip', 'Which city?', 'Lisbon', 'Booked Lisbon.']) expect(transcript).toContain(text);

      // answered: the next message in the thread is a new turn of the same session
      await second.send(threadMessage('Thanks', '100.3'));
      expect(second.posts[1]).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'You are welcome.' });
      expect(second.userTexts(1)).toEqual(['Book a trip', 'Thanks']);
    });
  });
});

describe('slackChannel sign-in', () => {
  it('sends the sign-in link ephemerally to the user who asked, with no buttons, and continues in the thread after the callback', async () => {
    const slack = fakeSlack();
    const { tool, executions } = listReposTool(githubProvider(fakeOAuthServer()));
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] }, 'You have lousho-demo.']), tools: [tool], store: memoryStore() });
    const handler = mountChannels(agent, [slackChannel({ signingSecret: SECRET, botToken: 'xoxb-test', fetch: slack.fetch })]);

    await send(handler, slack.log, event('list my repos'));
    expect(slack.posts).toEqual([]); // nothing in the thread for everyone
    expect(slack.ephemerals).toHaveLength(1);
    const [ephemeral] = slack.ephemerals;
    expect(ephemeral).toMatchObject({ channel: 'C1', thread_ts: '100.1', user: 'U1' });
    expect(ephemeral.blocks).toBeUndefined();
    expect(String(ephemeral.text)).toMatch(/^Sign in to GitHub to continue: https:\/\/github\.example\.com\/login\/oauth\/authorize\?/);

    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ kind: 'sign-in', principal: { id: 'U1', authenticator: 'slack' } });
    const state = new URL(String(ephemeral.text).slice(String(ephemeral.text).indexOf('https://'))).searchParams.get('state') ?? '';
    // approving before the sign-in fails, and the turn stays bound to the pause
    await expect(handler.resolveApproval({ id: pending.id, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_SIGNIN_PENDING' });
    await agent.oauth.complete({ state, code: 'code-u1' });
    await handler.resolveApproval({ id: pending.id, approved: true });
    expect(executions).toEqual(['gho_SECRET_u1_1']);
    expect(slack.posts).toEqual([{ channel: 'C1', thread_ts: '100.1', text: 'You have lousho-demo.' }]);
  });
});
