/**
 * The `/channels` routes of `mountChannels()` on the Fetch API
 * (mountFetchChannels, #298): `POST <basePath>/<name>` and
 * `POST <basePath>/<name>/approvals/:id`, Request in, Response out, so a
 * Worker host can serve the same channels.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineChannel, type Channel, type ChannelReplyContext } from './defineChannel';
import { httpChannel } from './httpChannel';
import { mountFetchChannels } from './fetchChannels';

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

const post = (path: string, body: unknown) => new Request(`http://worker${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('mountFetchChannels (#298)', () => {

  it('runs a turn through the channel and replies, acknowledging with the channel answer', async () => {
    const { channel, replies } = recordingChannel();
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['Hello there']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(replies.map((r) => r.text)).toEqual(['Hello there']);
    expect(replies[0].sessionId).toMatch(/^test_a-/);
  });

  it('a 500 does not leak the internal error message; the detail goes to onError', async () => {
    const secret = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod';
    const onError = vi.fn();
    const { channel } = recordingChannel({
      onError,
      verify: async () => {
        throw new Error(secret);
      },
    });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(500);
    const text = await response!.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({ error: 'The request failed. The server log has the details.' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: secret }), expect.objectContaining({ channel: 'test' }));
  });

  it('answers 401 when the channel verify fails', async () => {
    const { channel } = recordingChannel({ verify: async () => false });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(401);
  });

  it('awaits the turn when no waitUntil is given, then returns the early respond, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { channel, replies } = recordingChannel({
      async parse(_req, respond) {
        respond(202, { accepted: true });
        return { sessionKey: 'u', input: 'hi', replyTo: null };
      },
    });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['done', 'again']) }), [channel]);
    const response = await handler(post('/channels/test', {}));
    expect(await response?.json()).toEqual({ accepted: true });
    expect(replies.map((r) => r.text)).toEqual(['done']);
    await handler(post('/channels/test', {}));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/waitUntil/);
    warn.mockRestore();
  });

  it('answers 400 for a bad JSON body and for an approvals body without a decision', async () => {
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [httpChannel()]);
    const badJson = await handler(new Request('http://worker/channels/http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }));
    expect(badJson?.status).toBe(400);
    const noDecision = await handler(post('/channels/http/approvals/x', { unrelated: 1 }));
    expect(noDecision?.status).toBe(400);
  });
});
