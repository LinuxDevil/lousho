/**
 * A channel turn on a session another process or replica is running (its run
 * lease is held: `LOUSHO_SESSION_BUSY`) is a `409` with `Retry-After`, not a
 * `500`, and is reported as a failed turn, not a failed parse.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { httpChannel } from './httpChannel';
import { mountFetchChannels } from './fetchChannels';

/** An agent whose every turn fails as a run another replica holds the lease of. */
function busyAgent(): Pick<SimpleAgent, 'session' | 'approvals'> {
  const busy = new SDKError("The run checkpointed as 'http_ali' is running elsewhere", 'LOUSHO_SESSION_BUSY');
  const session = () => ({
    stream: () => {
      throw busy;
    },
  });
  return { session, approvals: { list: async () => [] } } as unknown as Pick<SimpleAgent, 'session' | 'approvals'>;
}

describe('channel turn on a busy session (LOUSHO_SESSION_BUSY)', () => {

  it('mountFetchChannels answers 409 with Retry-After and the coded error, and reports a failed turn', async () => {
    const onError = vi.fn();
    const handler = mountFetchChannels(busyAgent(), [httpChannel()], { onError });
    const request = new Request('http://worker/channels/http', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'ali', input: 'hi' }),
    });
    const response = await handler(request);
    expect(response?.status).toBe(409);
    expect(response?.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(await response?.json()).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toMatchObject({ channel: 'http', stage: 'turn' });
  });

  it('logs any other turn failure before the ack as a failed turn (still a 500 that hides the message)', async () => {
    const onError = vi.fn();
    const agent = {
      session: () => ({
        stream: () => {
          throw new Error('connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod');
        },
      }),
      approvals: { list: async () => [] },
    } as unknown as Pick<SimpleAgent, 'session' | 'approvals'>;
    const handler = mountFetchChannels(agent, [httpChannel()], { onError });
    const response = await handler(
      new Request('http://worker/channels/http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionKey: 'ali', input: 'hi' }) })
    );
    expect(response?.status).toBe(500);
    expect(JSON.stringify(await response?.json())).not.toContain('hunter2');
    expect(onError.mock.calls[0][1]).toMatchObject({ stage: 'turn' });
  });
});
