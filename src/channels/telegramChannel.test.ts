/**
 * `telegramChannel()` - the webhook secret token, private chats vs groups
 * and forum topics, plain-text replies split at 4096 characters, approvals as
 * inline keyboards, and a pending question across a restart. A fake `fetch`
 * stands in for the Bot API: no network.
 */
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { telegramChannel, type TelegramMessage, type TelegramUpdate } from './telegramChannel';
import { durableStores } from './__fixtures__/durableStores';
import { memoryStore } from '../storage/agentStore';
import { fakeOAuthServer, githubProvider, listReposTool } from '../oauth/__fixtures__/fakeOAuth';

const TOKEN = '123456:SECRET-bot-token';
const SECRET = 'webhook-secret_1';

interface Call {
  method: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A fake Bot API that records each call (`https://api.telegram.org/bot<token>/<method>`). */
function fakeTelegram() {
  const log: string[] = [];
  const calls: Call[] = [];
  let id = 100;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const prefix = `https://api.telegram.org/bot${TOKEN}/`;
    expect(String(url).startsWith(prefix)).toBe(true);
    const method = String(url).slice(prefix.length);
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    log.push(method);
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, log };
}

/** Posts `payload` to `handler` with the secret token header (or `secret`; `null` omits it). */
async function send(handler: ChannelsHandler, payload: unknown, secret: string | null = SECRET) {
  const headers = secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret };
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST', url: '/channels/telegram', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.json = JSON.parse(text ?? '{}') as Record<string, unknown>), fakeRes),
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

let updateId = 0;

/** A text message from user 7 (default: a private chat 42, message 11). */
function message(text: string, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
  return { update_id: ++updateId, message: { message_id: 11, from: { id: 7, first_name: 'Sam', username: 'sam' }, chat: { id: 42, type: 'private' }, text, ...extra } };
}

const group = (text: string, extra: Partial<TelegramMessage> = {}) => message(text, { chat: { id: -1001, type: 'supergroup' }, ...extra });

/** A tap of `user` (default: 7) on the keyboard of the approval message in chat 42. */
function tap(data: string, user = 7, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    update_id: ++updateId,
    callback_query: { id: `cb-${updateId}`, from: { id: user, first_name: `User ${user}`, username: `user${user}` }, data, message: { message_id: 101, chat: { id: 42, type: 'private' }, text: 'Approve?', ...extra } },
  };
}

interface SetupOptions {
  channel?: Partial<Parameters<typeof telegramChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const telegram = fakeTelegram();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const channel = telegramChannel({ botToken: TOKEN, secretToken: SECRET, botUsername: 'lousho_bot', fetch: telegram.fetch, ...extra.channel });
  const handler = mountChannels(agent, [channel], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...telegram, model, userTexts, send: (payload: unknown, secret?: string | null) => send(handler, payload, secret) };
}

/** Runs a message that pauses on `send_email` and returns the Approve button's `callback_data`. */
async function pause(t: ReturnType<typeof setup>) {
  await t.send(message('Email Sam'));
  return t.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data as string;
}

describe('telegramChannel', () => {
  it('rejects a missing or wrong secret token with 401 and runs nothing', async () => {
    const t = setup(['never']);

    expect((await t.send(message('hi'), null)).status).toBe(401);
    expect((await t.send(message('hi'), 'wrong')).status).toBe(401);
    expect((await t.send(message('hi'), `${SECRET}x`)).status).toBe(401);

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
    expect(() => telegramChannel({ botToken: '', secretToken: SECRET })).toThrow(/botToken/);
    expect(() => telegramChannel({ botToken: TOKEN, secretToken: '' })).toThrow(/secretToken/);
  });

  it('runs a redelivered update (same update_id) once', async () => {
    const t = setup(['Hi Sam', 'Second']);
    const update = message('hi');

    expect((await t.send(update)).status).toBe(200);
    expect((await t.send(update)).status).toBe(200);
    expect(t.model.calls).toHaveLength(1);
    await t.send(message('again'));
    expect(t.model.calls).toHaveLength(2);
    expect(t.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)).toEqual(['Hi Sam', 'Second']);
  });

  it('uses a caption as the text and ignores updates without text', async () => {
    const t = setup(['Nice photo']);

    await t.send(message('', { text: undefined, caption: 'Look at this' }));
    await t.send(message('', { text: undefined }));
    await t.send({ update_id: 1, edited_message: { message_id: 1 } });

    expect(t.userTexts(0)).toEqual(['Look at this']);
    expect(t.calls).toHaveLength(1);
  });

  it('a forum topic is its own session and the reply stays in the topic', async () => {
    const t = setup(['In topic 5', 'In topic 6']);
    const topic = (id: number) => ({ chat: { id: -1001, type: 'supergroup' }, is_topic_message: true, message_thread_id: id });

    await t.send(group('/ask hi', topic(5)));
    await t.send(group('/ask hi', topic(6)));

    expect(t.calls.map((c) => [c.body.chat_id, c.body.message_thread_id, c.body.text])).toEqual([
      [-1001, 5, 'In topic 5'],
      [-1001, 6, 'In topic 6'],
    ]);
    expect(t.userTexts(1)).toEqual(['hi']);
  });

  describe('groups', () => {

    it('a reply to one of the bot\'s own messages wakes it', async () => {
      const t = setup(['answer']);

      await t.send(group('and then?', { reply_to_message: { from: { id: 99, is_bot: true, username: 'lousho_bot' } } }));
      await t.send(group('and then?', { reply_to_message: { from: { id: 98, is_bot: true, username: 'other_bot' } } }));

      expect(t.userTexts(0)).toEqual(['and then?']);
      expect(t.model.calls).toHaveLength(1);
    });
  });

  it('splits a 9000-character reply into 3 messages at line breaks, each at most 4096 characters', async () => {
    const long = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}\n${'c'.repeat(3000)}`;
    const t = setup([long]);

    await t.send(message('write a lot'));

    expect(t.calls).toHaveLength(3);
    expect(t.calls.every((c) => c.body.text.length <= 4096)).toBe(true);
    expect(t.calls.map((c) => c.body.text).join('\n')).toBe(long);
    expect(t.calls[0].body.reply_parameters).toBeDefined();
    expect(t.calls[1].body.reply_parameters).toBeUndefined();
  });

  it('Deny declines the call', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Okay, not sent.'], { tools: [emailTool(execute)] });
    const approve = await pause(t);

    await t.send(tap(approve.replace(/^a:/, 'd:')));

    expect(execute).not.toHaveBeenCalled();
    expect(t.calls.find((c) => c.method === 'editMessageText')?.body.text).toBe('Approve?\nDenied by @user7.');
    expect(t.calls.at(-1)?.body.text).toBe('Okay, not sent.');
  });

  it('only the starter may approve by default; another user gets an alert and it stays pending', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
    const approve = await pause(t);

    await t.send(tap(approve, 8));

    expect(t.calls.slice(1)).toEqual([{ method: 'answerCallbackQuery', body: { callback_query_id: expect.any(String), text: 'You are not allowed to approve this request.', show_alert: true } }]);
    expect(execute).not.toHaveBeenCalled();
    await t.send(tap(approve, 7));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a value too long for 64 bytes drops the starter, so only a list or function of approvers can approve', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const big = { from: { id: '1234567890123456789012345678901234567890' as unknown as number, first_name: 'Sam' } }; // not reachable with real ids (at most 52 bits)
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['7'] } });

    await t.send(message('Email Sam', big));
    const data = t.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data as string;

    expect(data).toMatch(/^a::/);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    await t.send(tap(data, 7));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  describe('after a restart: a second channel over the same durable stores', () => {
    it('a pending ask_question survives a restart', async () => {
      const stores = durableStores();
      const agentOptions = { askQuestion: true, approvalStore: stores.approvalStore };
      const first = setup([ask], agentOptions, { mount: { store: stores.store } });
      await first.send(message('Book a trip'));
      expect(first.calls[0].body.text).toContain('Which city?');

      const second = setup(['Booked Lisbon.', 'You are welcome.'], agentOptions, { mount: { store: stores.store } });
      await second.send(message('Lisbon', { message_id: 12 }));

      expect(second.calls).toEqual([{ method: 'sendMessage', body: expect.objectContaining({ chat_id: 42, text: 'Booked Lisbon.' }) }]);
      expect(second.model.calls).toHaveLength(1);
      expect(JSON.stringify(second.model.calls[0].messages)).toContain('Lisbon');
      const transcript = await stores.transcript();
      for (const text of ['Book a trip', 'Which city?', 'Lisbon', 'Booked Lisbon.']) expect(transcript).toContain(text);

      // answered: the next message is a new turn of the same session
      await second.send(message('Thanks', { message_id: 13 }));
      expect(second.calls[1].body).toMatchObject({ text: 'You are welcome.' });
      expect(second.userTexts(1)).toEqual(['Book a trip', 'Thanks']);
    });
  });

  it('a network error whose message carries the URL does not leak the token either', async () => {
    const onError = vi.fn();
    const throwing = vi.fn(async (url: RequestInfo | URL) => {
      throw new Error(`connect ECONNREFUSED ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { onError, fetch: throwing } });

    await t.send(message('hi'));

    const error = onError.mock.calls[0][0] as Error;
    expect(error.message).toContain('sendMessage');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-bot-token');
  });

  it('the default error report never prints the token', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { fetch: failing } });

    await t.send(message('hi'));

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(' ')).not.toContain('SECRET-bot-token');
    spy.mockRestore();
  });
});


describe('telegramChannel sign-in', () => {
  const signInSetup = () => {
    const { tool } = listReposTool(githubProvider(fakeOAuthServer()));
    return setup([{ toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] }, 'done'], { tools: [tool], store: memoryStore() });
  };

  it('never posts the sign-in link in a group: it asks for a private chat', async () => {
    const t = signInSetup();
    await t.send(group('/ask@lousho_bot list my repos', { from: { id: 7, first_name: 'Sam', username: 'sam' } }));
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body.text).toMatch(/private chat/);
    expect(JSON.stringify(t.calls.map((c) => c.body))).not.toContain('github.example.com');
  });
});
