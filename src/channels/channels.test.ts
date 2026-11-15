/**
 * Channels - an inbound request maps to a session turn, the reply
 * goes back through the channel, `verify` guards it, and pauses go through
 * `onApproval` and `resolveApproval()`.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { defineChannel, type Channel, type ChannelContext, type ChannelReplyContext } from './defineChannel';
import { durableStores } from './__fixtures__/durableStores';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { httpChannel } from './httpChannel';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore } from '../session/sessionStore';

interface Posted {
  handled: boolean;
  status: number;
  json: Record<string, unknown>;
}

/** Drives `handler` with a fake `node:http` request and response pair. */
async function post(handler: ChannelsHandler, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Posted> {
  const req = Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers } });
  const res = { status: 0, body: '' };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.body = text ?? ''), fakeRes),
  };
  const handled = await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return { handled, status: res.status, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

/** A channel that records every reply instead of sending it anywhere. */
function recordingChannel(overrides: Partial<Channel> = {}) {
  const replies: ChannelReplyContext[] = [];
  const channel = defineChannel({
    name: 'test',
    async parse(req) {
      const { user, text } = JSON.parse(req.text) as { user: string; text: string };
      return { sessionKey: user, input: text, replyTo: `dm:${user}`, metadata: { user } };
    },
    async reply(ctx) {
      replies.push(ctx);
    },
    ...overrides,
  });
  return { channel, replies };
}

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { tool, execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

describe('defineChannel / mountChannels', () => {
  it('a 500 does not leak the internal error message; the detail goes to onError', async () => {
    const onError = vi.fn();
    const { channel } = recordingChannel({
      onError,
      verify: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod'), { code: 'ECONNREFUSED' });
      },
    });
    const res = await post(mountChannels(createAgent({ provider: mockModel(['hi']) }), [channel]), '/channels/test', { user: 'ali', text: 'hi' });
    expect(res).toEqual({ handled: true, status: 500, json: { error: 'The request failed. The server log has the details.', code: 'ECONNREFUSED' } });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('hunter2') }), expect.objectContaining({ channel: 'test', stage: 'parse' }));
  });

  it('httpChannel answers with plain JSON and leaves other routes to the host', async () => {
    const agent = createAgent({ provider: mockModel(['Pong']) });
    const handler = mountChannels(agent, [httpChannel()], { basePath: '/hooks/' });

    const res = await post(handler, '/hooks/http', { sessionKey: 'u1', input: 'ping' });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ text: 'Pong', finishReason: 'stop', sessionId: expect.stringMatching(/^http_u1-/) });
    expect((await post(handler, '/hooks/other', {})).handled).toBe(false);
    expect((await post(handler, '/chat', {})).handled).toBe(false);
    expect((await post(handler, '/hooks/http', { input: 'no key' })).status).toBe(400);
  });

  it('a channel without verify refuses a browser request from another site, and httpChannel a body that is not JSON', async () => {
    const model = mockModel(['Pong', 'Pong']);
    const handler = mountChannels(createAgent({ provider: model }), [httpChannel()]);
    const body = { sessionKey: 'u1', input: 'ping' };
    const local = { host: 'localhost:3737' };

    const refused = await post(handler, '/channels/http', body, { ...local, origin: 'https://evil.example' });
    expect(refused).toMatchObject({ status: 403, json: { code: 'LOUSHO_REQUEST_FORBIDDEN' } });
    // The refusal says how to accept such a page: authenticate it with `verify`.
    expect((refused.json as { error: string }).error).toMatch(/channel 'http' has no verify.*add a verify/);
    expect((await post(handler, '/channels/http', body, { ...local, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post(handler, '/channels/http/approvals/a1', { approved: true }, { ...local, origin: 'null' })).status).toBe(403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      expect(await post(handler, '/channels/http', body, { ...local, 'content-type': type })).toMatchObject({ status: 415, json: { code: 'LOUSHO_UNSUPPORTED_MEDIA_TYPE' } });
    }
    expect(model.calls).toHaveLength(0);
    // A page on the server's own origin, and a webhook sender (no Origin), still get through.
    expect((await post(handler, '/channels/http', body, { ...local, origin: 'http://localhost:3737' })).status).toBe(200);
    expect((await post(handler, '/channels/http', body, local)).status).toBe(200);
  });

  it('rejects a request that fails verify with 401, before parsing or running', async () => {
    const model = mockModel(['never']);
    const parse = vi.fn();
    const { channel, replies } = recordingChannel({ verify: async () => ({ ok: false, reason: 'bad signature' }), parse });
    const handler = mountChannels(createAgent({ provider: model }), [channel]);

    const res = await post(handler, '/channels/test', { user: 'ali', text: 'hi' });

    expect(res).toMatchObject({ status: 401, json: { error: 'Unauthorized' } });
    expect(parse).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('streams partial replies when stream is true', async () => {
    const { channel, replies } = recordingChannel({ stream: true });
    await post(mountChannels(createAgent({ provider: mockModel(['Hello there']) }), [channel]), '/channels/test', { user: 'a', text: 'hi' });
    expect(replies.some((r) => r.partial)).toBe(true);
    expect(replies.at(-1)).toMatchObject({ text: 'Hello there', result: { finishReason: 'stop' } });
    expect(replies.at(-1)?.partial).toBeUndefined();
  });

  it('an approval pause calls onApproval, and resolveApproval continues and replies', async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool] });
    const onApproval = vi.fn(async () => undefined);
    const { channel, replies } = recordingChannel({ onApproval });
    const handler = mountChannels(agent, [channel]);

    await post(handler, '/channels/test', { user: 'ali', text: 'Email Sam' });

    expect(onApproval).toHaveBeenCalledTimes(1);
    const [ctx] = onApproval.mock.calls[0] as unknown as [ChannelReplyContext];
    expect(ctx.approval).toMatchObject({ toolName: 'send_email', args: { to: 'sam@example.com' } });
    expect(ctx.text).toContain(`approval id: ${ctx.approval?.id}`);
    expect(replies).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();

    await handler.resolveApproval({ id: ctx.approval!.id, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Email sent.', sessionId: ctx.sessionId, inbound: { replyTo: 'dm:ali' } });
    await expect(handler.resolveApproval({ id: ctx.approval!.id, approved: true })).rejects.toThrow(/No pending channel approval/);
  });

  it('a stored pause binds only to the session its snapshot names; a foreign sessionKey decides nothing', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const sessions = new MemorySessionStore();
    const { tool, execute } = emailTool();
    const mount = (replies: Parameters<typeof mockModel>[0]) =>
      mountChannels(createAgent({ provider: mockModel(replies), tools: [tool], approvalStore }), [httpChannel()], { store: sessions });

    const paused = await post(mount([callEmail]), '/channels/http', { sessionKey: 'victim', input: 'Email Sam' });
    const id = (paused.json.approval as { id: string }).id;

    // A second process over the same stores: the pause is only known through the store.
    const second = mount(['Email sent.']);
    const foreign = await post(second, `/channels/http/approvals/${id}`, { approved: true, sessionKey: 'mallory' });
    expect(foreign.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
    // An unknown id is a 404 too: the route does not tell a live pause from a made-up one.
    expect((await post(second, '/channels/http/approvals/made-up', { approved: true, sessionKey: 'victim' })).status).toBe(404);

    const own = await post(second, `/channels/http/approvals/${id}`, { approved: true, sessionKey: 'victim' });
    expect(own.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('answers an ask_question pause over the approvals route (default onApproval = a text prompt via reply)', async () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?', options: ['Lisbon', 'Porto'] }, id: 'call_q' }] };
    const agent = createAgent({ provider: mockModel([ask, 'Booked Lisbon.']), askQuestion: true });
    const handler = mountChannels(agent, [httpChannel()]);

    const paused = await post(handler, '/channels/http', { sessionKey: 'u1', input: 'Book a trip' });
    const approval = paused.json.approval as { id: string; kind: string };
    expect(paused.json.finishReason).toBe('awaiting-approval');
    expect(approval.kind).toBe('question');
    expect(paused.json.text).toContain('Which city?\n1. Lisbon\n2. Porto');

    expect((await post(handler, `/channels/http/approvals/${approval.id}`, {})).status).toBe(400);
    expect((await post(handler, '/channels/http/approvals/nope', { answer: 'x' })).status).toBe(404);
    const done = await post(handler, `/channels/http/approvals/${approval.id}`, { answer: 'Lisbon' });
    expect(done.json).toMatchObject({ text: 'Booked Lisbon.', finishReason: 'stop', sessionId: paused.json.sessionId });
  });

  describe('ChannelContext.pendingQuestion', () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

    /** A custom channel whose next message answers a pending question; `ctx()` is the context its last parse got. */
    function answeringChannel() {
      let context: ChannelContext | undefined;
      const recorded = recordingChannel({
        async parse(req, _respond, ctx) {
          context = ctx;
          const { user, text } = JSON.parse(req.text) as { user: string; text: string };
          const inbound = { sessionKey: user, input: text, replyTo: `dm:${user}` };
          const question = await ctx.pendingQuestion(user);
          return question ? { decision: { id: question, answer: text }, inbound } : inbound;
        },
      });
      return { ...recorded, ctx: () => context! };
    }

    function mount(responses: Parameters<typeof mockModel>[0], stores: ReturnType<typeof durableStores>, tools = [emailTool().tool]) {
      const model = mockModel(responses);
      const agent = createAgent({ provider: model, askQuestion: true, tools, approvalStore: stores.approvalStore });
      const recorded = answeringChannel();
      return { ...recorded, model, agent, handler: mountChannels(agent, [recorded.channel], { store: stores.store }) };
    }

    it('in process: the question the session waits on, handed out once until it is answered', async () => {
      const t = mount([ask, 'Booked Lisbon.'], durableStores());
      await post(t.handler, '/channels/test', { user: 'ali', text: 'Book a trip' });
      const [approval] = await t.agent.approvals.list();
      expect(approval.kind).toBe('question');

      expect(await t.ctx().pendingQuestion('ali')).toBe(approval.id);
      expect(await t.ctx().pendingQuestion('ali')).toBeUndefined(); // claimed by the first caller
      expect(await t.ctx().pendingQuestion('sam')).toBeUndefined(); // another session
    });

    it('undefined for a session with no pending turn, or one waiting on a tool approval (the turn is not run)', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      await post(first.handler, '/channels/test', { user: 'ali', text: 'Email Sam' });
      expect(await first.ctx().pendingQuestion('ali')).toBeUndefined();

      const second = mount(['Hi Bob.'], stores);
      await post(second.handler, '/channels/test', { user: 'bob', text: 'hi' }); // a normal turn
      expect(second.replies.map((r) => r.text)).toEqual(['Hi Bob.']);
      expect(await second.ctx().pendingQuestion('ali')).toBeUndefined();
      expect(await second.ctx().pendingQuestion('nobody')).toBeUndefined();
      expect(second.model.calls).toHaveLength(1); // Bob's turn only: nothing of Ali's was run
    });
  });

  describe('button decisions are checked against the pending turn (#279)', () => {

    /**
     * A channel with buttons: `{ user, text }` is a message, `{ user, click, approved }` a click on
     * approval `click` in `user`'s conversation (the conversation as the click names it).
     */
    function clickingChannel() {
      let context: ChannelContext | undefined;
      const recorded = recordingChannel({
        async parse(req, _respond, ctx) {
          context = ctx;
          const body = JSON.parse(req.text) as { user: string; text?: string; click?: string; approved?: boolean };
          const inbound = { sessionKey: body.user, input: body.text ?? '', replyTo: `dm:${body.user}` };
          return body.click ? { decision: { id: body.click, approved: body.approved ?? true }, inbound, approver: { id: body.user } } : inbound;
        },
      });
      return { ...recorded, ctx: () => context! };
    }

    function mount(responses: Parameters<typeof mockModel>[0], stores: ReturnType<typeof durableStores>, execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) {
      const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
      const model = mockModel(responses);
      const agent = createAgent({ provider: model, tools: [tool], askQuestion: true, approvalStore: stores.approvalStore });
      const onDecision = vi.fn();
      const recorded = clickingChannel();
      return { ...recorded, model, agent, execute, onDecision, handler: mountChannels(agent, [recorded.channel], { store: stores.store, onDecision }) };
    }

    /** Pauses `user`'s conversation on send_email and returns the approval id. */
    async function pauseOn(t: ReturnType<typeof mount>, user: string): Promise<string> {
      const before = new Set((await t.agent.approvals.list()).map((request) => request.id));
      await post(t.handler, '/channels/test', { user, text: 'Email Sam' });
      return (await t.agent.approvals.list()).find((request) => !before.has(request.id))!.id;
    }

    it('in process: a second click while onDecision is still running is a 409, not a failure', async () => {
      const t = mount([callEmail, 'Email sent.', 'never'], durableStores());
      t.onDecision.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
      const ali = await pauseOn(t, 'ali');

      const [a, b] = await Promise.all([1, 2].map(() => post(t.handler, '/channels/test', { user: 'ali', click: ali })));

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a, b].find((r) => r.status === 409)?.json).toMatchObject({ code: 'LOUSHO_APPROVAL_CONFLICT' });
      expect(t.execute).toHaveBeenCalledTimes(1);
      expect(t.onDecision).toHaveBeenCalledTimes(1);
      expect(t.replies.map((r) => r.text)).toEqual([expect.any(String), 'Email sent.']);
    });

    it('a click that acknowledged the surface first and lost the race is a no-op, not a "request failed" reply', async () => {
      const stores = durableStores();
      const { tool, execute } = emailTool();
      const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.', 'never']), tools: [tool], approvalStore: stores.approvalStore });
      const onError = vi.fn();
      const { channel, replies } = recordingChannel({
        onError,
        async parse(req, respond) {
          respond(200, { ok: true }); // a surface that acks before the decision runs (Slack, Discord)
          const body = JSON.parse(req.text) as { user: string; text?: string; click?: string };
          const inbound = { sessionKey: body.user, input: body.text ?? '', replyTo: `dm:${body.user}` };
          return body.click ? { decision: { id: body.click, approved: true }, inbound, approver: { id: body.user } } : inbound;
        },
      });
      const onDecision = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
      const handler = mountChannels(agent, [channel], { store: stores.store, onDecision });
      await post(handler, '/channels/test', { user: 'ali', text: 'Email Sam' });
      const [{ id }] = await agent.approvals.list();

      await Promise.all([1, 2].map(() => post(handler, '/channels/test', { user: 'ali', click: id })));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(replies.map((r) => r.text)).not.toContain('Sorry, that request failed.');
      expect(replies.at(-1)?.text).toBe('Email sent.');
    });
  });

  describe('the approvals route after a restart', () => {
    function mountHttp(responses: Parameters<typeof mockModel>[0], stores: ReturnType<typeof durableStores>, execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) {
      const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
      const agent = createAgent({ provider: mockModel(responses), tools: [tool], approvalStore: stores.approvalStore });
      return { agent, execute, handler: mountChannels(agent, [httpChannel()], { store: stores.store }) };
    }

    it('in process, a `sessionKey` naming another conversation is refused', async () => {
      const t = mountHttp([callEmail, 'Email sent.'], durableStores());
      const paused = await post(t.handler, '/channels/http', { sessionKey: 'u1', input: 'Email Sam' });
      const id = (paused.json.approval as { id: string }).id;
      expect(await post(t.handler, `/channels/http/approvals/${id}`, { approved: true, sessionKey: 'u2' })).toMatchObject({ status: 404 });
      expect(await post(t.handler, `/channels/http/approvals/${id}`, { approved: true, sessionKey: 'u1' })).toMatchObject({ status: 200, json: { text: 'Email sent.' } });
    });
  });

  it('rejects an invalid channel name and duplicate names', () => {
    expect(() => recordingChannel({ name: 'has space' })).toThrow(/Invalid channel name/);
    const { channel } = recordingChannel();
    expect(() => mountChannels(createAgent({ provider: mockModel([]) }), [channel, channel])).toThrow(/unique/);
  });
});

describe('channels: a step paused on several calls', () => {
  const twoEmails = {
    toolCalls: [
      { name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_sam' },
      { name: 'send_email', args: { to: 'kim@example.com' }, id: 'call_kim' },
    ],
  };

  it('prompts each call once; each is decided on its own and the last decision runs the step', async () => {
    const { tool, execute } = emailTool();
    const onApproval = vi.fn(async (_ctx: ChannelReplyContext) => undefined);
    const { channel, replies } = recordingChannel({ onApproval });
    const handler = mountChannels(createAgent({ provider: mockModel([twoEmails, 'Both sent.']), tools: [tool] }), [channel]);

    await post(handler, '/channels/test', { user: 'ali', text: 'Email Sam and Kim' });
    expect(onApproval).toHaveBeenCalledTimes(2);
    const prompted = onApproval.mock.calls.map(([ctx]) => ctx);
    expect(prompted.map((ctx) => ctx.approval?.args)).toEqual([{ to: 'sam@example.com' }, { to: 'kim@example.com' }]);
    expect(prompted[0].approvals).toHaveLength(2);
    const [sam, kim] = prompted.map((ctx) => ctx.approval!.id);

    const decided = await post(handler, `/channels/test/approvals/${kim}`, { approved: true });
    expect(decided.status).toBe(200);
    expect(execute).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalledTimes(2);
    expect(replies.at(-1)?.text).toBe(`Decision recorded. Still waiting on: send_email (approval id: ${sam}).`);

    await post(handler, `/channels/test/approvals/${sam}`, { approved: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ to: 'kim@example.com' });
    expect(replies.at(-1)?.text).toBe('Both sent.');
  });

  it('after a restart, a decision on any call of the step is bound to its conversation', async () => {
    const stores = durableStores();
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const mount = (responses: Parameters<typeof mockModel>[0]) => {
      const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
      const agent = createAgent({ provider: mockModel(responses), tools: [tool], approvalStore: stores.approvalStore });
      return mountChannels(agent, [httpChannel()], { store: stores.store });
    };
    const paused = await post(mount([twoEmails]), '/channels/http', { sessionKey: 'u1', input: 'Email Sam and Kim' });
    const [sam, kim] = (paused.json.approvals as Array<{ id: string }>).map((approval) => approval.id);

    const second = mount([]);
    expect(await post(second, `/channels/http/approvals/${kim}`, { approved: true, sessionKey: 'u2' })).toMatchObject({ status: 404 });
    expect(await post(second, `/channels/http/approvals/${kim}`, { approved: true, sessionKey: 'u1' })).toMatchObject({ status: 200, json: { finishReason: 'awaiting-approval' } });
    expect(execute).not.toHaveBeenCalled();

    const done = await post(mount(['Both sent.']), `/channels/http/approvals/${sam}`, { approved: true, sessionKey: 'u1' });
    expect(done).toMatchObject({ status: 200, json: { finishReason: 'stop', text: 'Both sent.' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
