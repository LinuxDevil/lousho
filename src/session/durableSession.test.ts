/**
 * Checkpointed sessions. Every turn is checkpointed per step, so a
 * turn interrupted mid-way (a crash, a failed checkpoint write) is finished
 * by `session.resume()` in a fresh agent, without re-running finished steps.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { SqliteStore } from '../storage/sqlite';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockStaticTurn } from '../testing';
import { MemorySessionStore } from './index';

type Runs = Record<string, number>;

/** A tool that counts its runs and, with `crashOnce`, dies (PropagatingToolError) on its first run. */
function tool(name: string, runs: Runs, options: { crashOnce?: boolean; needsApproval?: boolean } = {}): DefinedTool {
  runs[name] = 0;
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    needsApproval: options.needsApproval,
    execute: async () => {
      runs[name]++;
      if (options.crashOnce && runs[name] === 1) throw new PropagatingToolError(`process died while running ${name}`);
      return `${name} done`;
    },
  });
}

/** A KVCheckpointStore over a Map (JSON round-trip), optionally failing the n-th save (1-based). */
function checkpointStore(failSave?: number): KVCheckpointStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let saves = 0;
  const store = new KVCheckpointStore({
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      // Run leases (`<id>#lease`) are not checkpoint saves.
      if (!key.endsWith('#lease')) saves++;
      if (saves === failSave && !key.endsWith('#lease')) throw new Error('disk gone');
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  }, undefined, undefined, { historyLimit: 0 }); // these tests count puts as saves
  return Object.assign(store, { data });
}

const calling = (name: string): MockStaticTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);
/** Checkpoint keys except `<id>.turn-counter`, the bookkeeping record a commit leaves. */
const liveKeys = (data: Map<string, string>): string[] => [...data.keys()].filter((key) => !key.endsWith('.turn-counter'));

describe('checkpointed sessions', () => {

  it('a turn that finished just before its transcript was saved is added to the transcript, not run again', async () => {
    const sessions = new MemorySessionStore();
    const checkpoints = checkpointStore();
    const failing = Object.assign(Object.create(sessions) as MemorySessionStore, {
      save: async () => {
        throw new Error('session store gone');
      },
      saveIf: async () => {
        throw new Error('session store gone');
      },
    });
    const model = mockModel(['Hi.']);
    await expect(createAgent({ provider: model }).session({ id: 'chat', store: failing, checkpointStore: checkpoints }).send('hello')).rejects.toThrow(
      'session store gone'
    );

    const session = createAgent({ provider: mockModel([]) }).session({ id: 'chat', store: sessions, checkpointStore: checkpoints });
    expect(await session.resume()).toBeNull();
    expect(roles(session.messages)).toEqual(['user', 'assistant']);
    expect(roles((await sessions.load('chat'))!)).toEqual(['user', 'assistant']);
    expect(liveKeys(checkpoints.data)).toEqual([]);
  });

  it('streamResolve() from a fresh agent commits the session turn too', async () => {
    const runs: Runs = {};
    const tools = [tool('write_file', runs, { needsApproval: true })];
    const store = memoryStore();
    const before = createAgent({ provider: mockModel([calling('write_file')]), tools, store });
    const paused = await before.session({ id: 'chat' }).send('update a.txt');

    const after = createAgent({ provider: mockModel(['Wrote it.']), tools, store });
    const run = after.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const events: string[] = [];
    for await (const event of run) events.push(event.type);
    const result = await run.result;

    expect(result.text).toBe('Wrote it.');
    expect(events).toContain('run.start');
    expect(roles(await after.session({ id: 'chat' }).load())).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('a continuation that fails after approval leaves a resumable turn holding the executed tool result', async () => {
    // The stale checkpoint was deleted before the continued
    // run, so a failure there erased the approved, already-executed call.
    const runs: Runs = {};
    const tools = [tool('refund', runs, { needsApproval: true })];
    const store = memoryStore();
    const agent = createAgent({
      provider: mockModel([calling('refund'), { error: new Error('Context size has been exceeded.') }, 'The $129 refund went through.']),
      tools,
      store,
    });
    const session = agent.session({ id: 'cust-1' });
    const paused = await session.send('refund my $129 order');
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('Context size has been exceeded');
    expect(runs.refund).toBe(1);

    // The turn is still pending (in-progress), with the tool result recorded.
    const checkpoint = await store.checkpoints.load('cust-1.turn-0');
    expect(checkpoint?.status).toBe('in-progress');
    expect(checkpoint?.messages.map((m) => m.role)).toContain('tool');

    const fresh = agent.session({ id: 'cust-1' });
    expect(await fresh.pending()).toMatchObject({ status: 'in-progress' });
    const done = await fresh.resume();
    expect(done?.text).toBe('The $129 refund went through.');
    expect(runs.refund).toBe(1); // the approved call did not run again
    expect(roles(await fresh.load())).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await store.checkpoints.load('cust-1.turn-0')).toBeNull();
  });

  it('keeps the checkpoint history of only the last turnHistoryLimit turns, so storage does not grow with every turn', async () => {
    const store = memoryStore();
    const runs: Runs = {};
    const model = mockModel([(r) => (r.messages.at(-1)?.role === 'tool' ? 'Noted.' : calling('lookup'))], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, tools: [tool('lookup', runs)], store });
    const session = agent.session({ id: 'chat', turnHistoryLimit: 2 });
    for (let turn = 0; turn < 6; turn++) await session.send(`turn ${turn}`);
    // Each turn adds four messages: turn n is checkpointed as chat.turn-<4n>.
    const kept = [];
    for (let n = 0; n < 6; n++) if ((await store.checkpoints.history!(`chat.turn-${4 * n}`)).length > 0) kept.push(n);
    expect(kept).toEqual([4, 5]);
    expect(() => agent.session({ id: 'x', turnHistoryLimit: -1 })).toThrow(/turnHistoryLimit/);

    const none = agent.session({ id: 'none', turnHistoryLimit: 0 });
    await none.send('hi');
    expect(await store.checkpoints.history!('none.turn-0')).toEqual([]);
  });

  // A store object per turn (serverless, CLI runs, restarts): what earlier commits deleted is not known in memory,
  // and the turn that just left the window must go anyway.
  it.each([
    ['SqliteStore(file)', (dir: string) => new SqliteStore(join(dir, 'agent.db'))],
  ])('keeps turn history at turnHistoryLimit when every turn uses a new store object (%s)', async (_name, makeStore) => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-turn-history-'));
    try {
      const turns = 85;
      for (let turn = 0; turn < turns; turn++) {
        const store = makeStore(dir);
        const agent = createAgent({ provider: mockModel(['ok']), store });
        await agent.session({ id: 'chat' }).send(`turn ${turn}`);
        if ('close' in store) store.close();
      }
      const store = makeStore(dir);
      // Each turn adds two messages: turn n is checkpointed as chat.turn-<2n>.
      const kept = [];
      for (let n = 0; n < turns; n++) if ((await store.checkpoints.history!(`chat.turn-${2 * n}`)).length > 0) kept.push(n);
      if ('close' in store) store.close();
      expect(kept).toEqual(Array.from({ length: 10 }, (_, i) => turns - 10 + i));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('an aborted turn, discardPending() and clear() leave no pending turn', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const store = { sessions: new MemorySessionStore(), checkpoints: checkpointStore() };
    const session = createAgent({ provider: mockModel([calling('a'), calling('b'), calling('a'), calling('b')]), tools }).session({ id: 'chat', store });

    const aborted = await session.send('go', { signal: AbortSignal.abort() });
    expect(aborted.finishReason).toBe('aborted');
    expect(await session.pending()).toBeNull();

    await expect(session.send('go')).rejects.toThrow('process died');
    expect(await session.pending()).toMatchObject({ status: 'in-progress' });
    await session.discardPending();
    expect(await session.pending()).toBeNull();
    expect(session.messages).toEqual([]);

    runs.b = 0;
    await expect(session.send('go')).rejects.toThrow('process died');
    await session.clear();
    expect(liveKeys(store.checkpoints.data)).toEqual([]);
  });
});
