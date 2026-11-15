/**
 * A model step with several calls that need approval pauses
 * once, on all of them (`approvalIds`); they can be decided in any order, and
 * the step's approved calls run only once every one of them is decided.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { mockModel } from './testing';
import { fileStore } from './storage/fileStore';
import { type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';

function tools(log: string[]) {
  const make = (name: string, needsApproval: boolean) =>
    defineTool({
      name,
      description: name,
      input: z.object({ n: z.number() }),
      needsApproval,
      execute: async ({ n }) => {
        log.push(`${name}(${n})`);
        return `${name} ok`;
      },
    });
  return [make('wire_money', true), make('delete_db', true), make('read_status', false)];
}

const twoApprovals = {
  toolCalls: [
    { name: 'wire_money', args: { n: 1 }, id: 'call_wire' },
    { name: 'delete_db', args: { n: 2 }, id: 'call_delete' },
  ],
};

describe('parallel approvals', () => {

  it('resolveAll() decides the whole step at once, with edited arguments', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    const [wire, del] = paused.approvalIds!;

    const result = await agent.approvals.resolveAll([
      { id: wire, approved: true, args: { n: 10 } },
      { id: del, approved: true },
    ]);

    expect(result.text).toBe('done');
    expect(log).toEqual(['wire_money(10)', 'delete_db(2)']);
    const call = result.messages.find((m) => m.role === 'assistant' && m.toolCalls)?.toolCalls?.find((c) => c.id === 'call_wire');
    expect(JSON.parse(call!.function.arguments)).toEqual({ n: 10 });
    await expect(agent.approvals.resolveAll([])).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it('an approve callback is asked about each call; a deferred one is left to a human', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const agent = createAgent({
      provider: mockModel([twoApprovals, 'done']),
      tools: tools(log),
      approve: ({ toolName }) => {
        asked.push(toolName);
        return toolName === 'wire_money' ? 'defer' : true;
      },
    });
    const paused = await agent.send('go');
    expect(asked).toEqual(['wire_money', 'delete_db']);
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalIds).toHaveLength(1);
    expect(log).toEqual([]);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('done');
    expect(asked).toEqual(['wire_money', 'delete_db']);
    expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
  });

  it("edited args on a sub-agent's grouped approval are validated before its calls run", async () => {
    const log: string[] = [];
    const worker = createAgent({ provider: mockModel([twoApprovals, 'worker done']), tools: tools(log), description: 'Does risky things' });
    const task = { name: 'task', args: { agent: 'worker', prompt: 'do it', description: 'risky' } };
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task] }, 'lead done']), subagents: { worker } });

    const paused = await lead.send('go');
    const [wire, del] = paused.approvalIds!;
    await lead.approvals.resolve({ id: del, approved: true });
    // { n: 'x' } fails the tool's zod schema: it must not reach execute().
    const result = await lead.approvals.resolve({ id: wire, approved: true, args: { n: 'x' } });

    expect(log).toEqual([]);
    expect(result.text).toBe('lead done');
    const taskResult = result.messages.find((m) => m.role === 'tool' && m.toolName === 'task');
    expect(taskResult?.isError).toBe(true);
    expect(String(taskResult?.content)).toContain("Invalid arguments for tool 'wire_money'");
  });
});

describe('parallel approvals with durable stores', () => {
  const dirs: string[] = [];
  const opened: Array<{ close(): void }> = [];
  afterEach(() => {
    while (opened.length) opened.pop()?.close();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-parallel-appr-'));
    dirs.push(dir);
    return dir;
  };
  const kinds: Array<[string, () => () => AgentStore]> = [
    ['fileStore', () => {
      const dir = tempDir();
      return () => fileStore(dir);
    }],
    ['SqliteStore', () => {
      const path = join(tempDir(), 'agent.db');
      return () => {
        const store = new SqliteStore(path);
        opened.push(store);
        return store;
      };
    }],
  ];

  for (const [name, setup] of kinds) {
    it(`${name}: each call is decided by a different process; the last one runs the step in its session`, async () => {
      const mkStore = setup();
      const log: string[] = [];
      const a = createAgent({ provider: mockModel([twoApprovals]), tools: tools(log), store: mkStore() });
      const paused = await a.session({ id: 'durable' }).send('go');
      const [wire, del] = paused.approvalIds!;

      const b = createAgent({ provider: mockModel([]), tools: tools(log), store: mkStore() }); // "restart"
      expect((await b.approvals.list()).map((p) => p.id)).toEqual([wire, del]);
      const partial = await b.approvals.resolve({ id: wire, approved: true });
      expect(partial.approvalIds).toEqual([del]);
      expect(log).toEqual([]);

      const c = createAgent({ provider: mockModel(['done']), tools: tools(log), store: mkStore() }); // another restart
      expect((await c.approvals.list()).map((p) => p.id)).toEqual([del]);
      expect(await c.session({ id: 'durable' }).pending()).toMatchObject({ status: 'awaiting-approval', approvalId: del });
      const result = await c.approvals.resolve({ id: del, approved: true });
      expect(result.text).toBe('done');
      expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
      const session = c.session({ id: 'durable' });
      await session.load();
      expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    });
  }
});
