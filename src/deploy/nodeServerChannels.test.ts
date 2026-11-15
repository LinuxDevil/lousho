/** The node server mounts the channels of the agent directory it serves. */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { createDeployedServer } from './nodeServer';
import { httpChannel } from '../channels/httpChannel';
import type { Channel } from '../channels/defineChannel';
import type { SimpleAgent } from '../createAgent';

/** Listens on a free port; resolves the base URL and a closer. */
async function listen(agent: SimpleAgent, channels: readonly Channel[], env: NodeJS.ProcessEnv = { LOUSHO_API_TOKEN: 'secret' }) {
  const deployed = createDeployedServer(agent, { env, channels });
  await new Promise<void>((resolve) => deployed.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise((resolve) => deployed.server.close(resolve));
    await agent.close();
  };
  return { base, close, channelRoutes: deployed.channelRoutes };
}

describe('node server channels', () => {

  describe('route auth', () => {
    const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    it('leaves a channel with its own verify reachable without the bearer token', async () => {
      const api = httpChannel({ verify: async (req) => req.headers['x-api-key'] === 'k' });
      const { base, close, channelRoutes } = await listen(createAgent({ provider: mockModel(['pong']), instructions: 'x' }), [api]);
      try {
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'a', input: 'hi' }, { 'x-api-key': 'nope' }))).status).toBe(401);
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'a', input: 'hi' }, { 'x-api-key': 'k' }))).status).toBe(200);
        expect(channelRoutes).toEqual([{ name: 'http', auth: 'self-verified' }]);
      } finally {
        await close();
      }
    });
  });
});
