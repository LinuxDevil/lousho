/**
 * `createDeployedServer().shutdown()` drains the node server on
 * SIGTERM - it stops accepting, stops the schedules, waits (bounded) for the
 * turns in flight, then closes what is left - instead of `agent.close()`
 * cutting running turns off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createDeployedServer } from './nodeServer';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A server whose agent's `slow` tool waits until `release()`. */
async function slowServer() {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const started = vi.fn();
  const slow = defineTool({
    name: 'slow',
    description: 'Takes a while',
    input: z.object({}),
    execute: async () => (started(), await gate, 'finished'),
  });
  const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow', args: {} }] }, 'done after slow']), instructions: 'x', tools: [slow] });
  closers.push(() => agent.close());
  const deployed = createDeployedServer(agent, { env: {} });
  closers.push(() => deployed.shutdown({ timeoutMs: 50 }));
  await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}`;
  return { ...deployed, url, release, started };
}

describe('createDeployedServer().shutdown()', () => {

  it('gives up waiting after timeoutMs and closes the connections left', async () => {
    const { url, shutdown, started, release } = await slowServer();
    const turn = fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go' }) }).catch((error: Error) => error);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const start = Date.now();
    await shutdown({ timeoutMs: 100 });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running after 100 ms'));
    expect(await turn).toBeInstanceOf(Error);
    warn.mockRestore();
    release();
  });
});
