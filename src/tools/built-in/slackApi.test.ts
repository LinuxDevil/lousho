import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSlackApiTools } from './slackApi';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('SlackApiTools', () => {
  const tools = createSlackApiTools({ botToken: 'xoxb-test' });
  const run = (name: string, args: Record<string, unknown>) => getToolExecute(tools.get(name)!)!(args, ctx);
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces Slack's error when ok is false", async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: false, error: 'channel_not_found' }));
    await expect(run('slack_read_messages', { channel: 'C1', limit: 10 })).rejects.toThrow(/conversations\.history failed: channel_not_found/);
  });

  it('posts a message as JSON with a bearer token', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, channel: 'C1', ts: '1700000000.000100' }));
    const result = JSON.parse(await run('slack_post_message', { channel: 'C1', text: 'hi', threadTs: '1.2' }) as string);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.Authorization).toBe('Bearer xoxb-test');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C1', text: 'hi', thread_ts: '1.2' });
    expect(result).toEqual({ channel: 'C1', ts: '1700000000.000100' });
  });

  it('resolves a channel name across pages', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ ok: true, channels: [{ id: 'C1', name: 'random' }], response_metadata: { next_cursor: 'next' } }))
      .mockResolvedValueOnce(json({ ok: true, channels: [{ id: 'C2', name: 'eng-alerts' }], response_metadata: { next_cursor: '' } }));
    const result = JSON.parse(await run('slack_resolve_channel', { name: '#Eng-Alerts' }) as string);

    expect(result.id).toBe('C2');
    expect(new URLSearchParams(fetchSpy.mock.calls[1][1].body).get('cursor')).toBe('next');
  });

  it('throws when the channel name is not found', async () => {
    fetchSpy.mockResolvedValueOnce(json({ ok: true, channels: [], response_metadata: { next_cursor: '' } }));
    await expect(run('slack_resolve_channel', { name: 'nope' })).rejects.toThrow(/not found/);
  });
});
