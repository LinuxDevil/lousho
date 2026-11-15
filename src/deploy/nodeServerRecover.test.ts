/**
 * The deployed node server finishes the runs a crash left interrupted once it
 * listens (`agent.recover()`): only the in-flight step runs again, runs paused
 * on an approval are left alone, and `LOUSHO_RECOVER_ON_START=0` turns it off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { fileStore } from '../storage/fileStore';
import { mockModel, type MockTurn } from '../testing';
import { createDeployedServer, type DeployedServerOptions } from './nodeServer';
import type { SimpleAgent } from '../createAgent';

const calling = (name: string): MockTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const closers: (() => Promise<unknown>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * `charge` counts its calls (the step that completed before the crash);
 * `crash` dies the first time it runs, as the process would mid-tool, and
 * waits on `gate` after that; `send_email` needs an approval.
 */
function tools(runs: Record<string, number>, gate: Promise<void> = Promise.resolve()): DefinedTool[] {
  runs.charge ??= 0;
  runs.crash ??= 0;
  runs.send_email ??= 0;
  return [
    defineTool({ name: 'charge', description: 'charge', input: z.object({}), execute: async () => `charged ${++runs.charge}` }),
    defineTool({
      name: 'crash',
      description: 'crash',
      input: z.object({}),
      execute: async () => {
        if (++runs.crash === 1) throw new PropagatingToolError('process died');
        await gate;
        return 'ok';
      },
    }),
    defineTool({ name: 'send_email', description: 'email', input: z.object({}), needsApproval: true, execute: async () => `sent ${++runs.send_email}` }),
  ];
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-server-recover-'));
  dirs.push(dir);
  return dir;
}

/** Leaves session `id` of the store in `dir` with a turn interrupted mid-tool: `charge` ran, `crash` died. */
async function interruptedTurn(dir: string, id: string, runs: Record<string, number>): Promise<void> {
  const before = createAgent({ provider: mockModel([calling('charge'), calling('crash')]), tools: tools(runs), store: fileStore(dir) });
  await expect(before.session({ id }).send('charge, then finish')).rejects.toThrow('process died');
  expect(await before.pending()).toEqual([expect.objectContaining({ sessionId: id, kind: 'session', status: 'in-progress' })]);
}

async function serve(agent: SimpleAgent, options: DeployedServerOptions) {
  closers.push(() => agent.close());
  const deployed = createDeployedServer(agent, options);
  closers.push(() => deployed.shutdown({ timeoutMs: 200 }));
  await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
  return { ...deployed, url: `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}` };
}

interface SessionView {
  messages: { role: string; content?: unknown }[];
  pending: { status: string } | null;
}

async function sessionView(url: string, id: string): Promise<SessionView> {
  return (await (await fetch(`${url}/chat/${id}`)).json()) as SessionView;
}

describe('createDeployedServer() crash recovery', () => {

  it.each([
    ['LOUSHO_RECOVER_ON_START=false', { env: { LOUSHO_RECOVER_ON_START: 'false' }, recovery: { intervalMs: 10 } }],
  ] as const)('does nothing with %s', async (_name, options) => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    await interruptedTurn(dir, 'chat-off', runs);

    const agent = createAgent({ provider: mockModel(['all done']), tools: tools(runs), store: fileStore(dir) });
    const { url } = await serve(agent, options);
    await sleep(150);

    expect(runs).toMatchObject({ charge: 1, crash: 1 });
    expect((await sessionView(url, 'chat-off')).pending).toMatchObject({ status: 'in-progress' });
  });

  it('answers a resend with the same Idempotency-Key that races the recovery without running the turn again', async () => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'msg-1' };
    const body = JSON.stringify({ sessionId: 'chat-key', input: 'charge, then finish' });
    const before = createAgent({ provider: mockModel([calling('charge'), calling('crash')]), tools: tools(runs), store: fileStore(dir) });
    const first = await serve(before, { env: {}, recovery: false });
    await (await fetch(`${first.url}/chat`, { method: 'POST', headers, body })).text();
    expect(runs).toMatchObject({ charge: 1, crash: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const agent = createAgent({ provider: mockModel(['all done', 'not used']), tools: tools(runs, gate), store: fileStore(dir) });
    const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 20 } });
    await vi.waitFor(() => expect(runs.crash).toBe(2), { timeout: 3000 });

    const resending = fetch(`${url}/chat`, { method: 'POST', headers, body });
    await sleep(100);
    release();
    const resend = await resending;
    expect(resend.status).toBe(200);
    expect(await resend.text()).toContain('"text":"all done"');
    expect(runs).toMatchObject({ charge: 1, crash: 2 });
    const { messages, pending } = await sessionView(url, 'chat-key');
    expect(pending).toBeNull();
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
