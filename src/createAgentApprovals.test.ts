/**
 * CreateAgent() agents pause for approval (in-memory store by
 * default) and resume with `agent.approvals.resolve()` or an `approve` callback.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { mockModel } from './testing';
import { ask, MAX_APPROVAL_TTL_MS } from './execution/permissions';
import { fileStore } from './storage/fileStore';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute,
  });
  return { tool, execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

describe('createAgent approvals: expiry (TTL)', () => {

  it('stamps expiresAt on the pause, list() and the approval.requested event', async () => {
    const events: string[] = [];
    const seen = vi.fn();
    const agent = createAgent({
      provider: mockModel([callEmail]),
      tools: [emailTool().tool],
      approvalTtlMs: 60_000,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'approval.requested') seen(event);
      },
    });

    const paused = await agent.send('Email Sam');

    const [pending] = await agent.approvals.list();
    expect(pending?.expiresAt).toBeDefined();
    expect(Date.parse(pending!.expiresAt!) - Date.now()).toBeGreaterThan(0);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.requested', expiresAt: pending!.expiresAt }));
    expect(paused.finishReason).toBe('awaiting-approval');
  });

  it('an approve callback still waiting at the deadline loses to it', async () => {
    const { tool, execute } = emailTool();
    const approve = vi.fn(() => new Promise<boolean>(() => {})); // a UI that never answers
    // Long enough that the pause has not expired yet when approve is called (an expired one skips approve), even on a loaded machine.
    const agent = createAgent({ provider: mockModel([callEmail, 'Understood.']), tools: [tool], approve, approvalTtlMs: 500 });

    const result = await agent.send('Email Sam');

    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Understood.');
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('rejects an absurdly long approval deadline (a typo would otherwise mean "never expires")', async () => {
    expect(() => createAgent({ provider: mockModel(['x']), approvalTtlMs: 1e20 })).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    expect(() => createAgent({ provider: mockModel(['x']), approvalTtlMs: MAX_APPROVAL_TTL_MS + 1 })).toThrow(/at most 100 years/);
    expect(() => createAgent({ provider: mockModel(['x']), approvalTtlMs: MAX_APPROVAL_TTL_MS })).not.toThrow();
    expect(() => ask('deploy', { ttlMs: 1e20 })).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    const agent = createAgent({ provider: mockModel(['x']) });
    await expect(agent.send('hi', { approvalTtlMs: 1e20 })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});

describe('createAgent approvals: durable list and cross-process staleness', () => {
  const dirs: string[] = [];
  const opened: Array<{ close(): void }> = [];
  afterEach(() => {
    while (opened.length) opened.pop()?.close();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-appr-list-'));
    dirs.push(dir);
    return dir;
  };

  const kinds: Array<[string, () => () => AgentStore]> = [
    [
      'fileStore',
      () => {
        const dir = tempDir();
        return () => fileStore(dir);
      },
    ],
    [
      'SqliteStore',
      () => {
        const path = join(tempDir(), 'agent.db');
        return () => {
          const store = new SqliteStore(path);
          opened.push(store);
          return store;
        };
      },
    ],
    [
      'memoryStore (shared)',
      () => {
        const store = memoryStore();
        return () => store;
      },
    ],
  ];

  for (const [name, setup] of kinds) {
    it(`${name}: list() after a restart shows the stored pause; get()/list() drop it once another agent resolves it`, async () => {
      const mkStore = setup();
      const { tool, execute } = emailTool();
      const a = createAgent({ provider: mockModel([callEmail, 'done A']), tools: [tool], store: mkStore() });
      const paused = await a.send('Email Sam');
      expect(await a.approvals.list()).toHaveLength(1);

      const b = createAgent({ provider: mockModel(['done B']), tools: [tool], store: mkStore() }); // "restart"
      const listed = await b.approvals.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });

      const result = await b.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(result.text).toBe('done B');
      expect(execute).toHaveBeenCalledTimes(1);

      // A still remembered the pause in memory: it must not report it any more.
      expect(await a.approvals.get(paused.approvalId!)).toBeUndefined();
      expect(await a.approvals.list()).toEqual([]);
      expect(await b.approvals.list()).toEqual([]);
    });
  }

  it("a store without list() or load() still lists and gets this process's pauses", async () => {
    const inner = new InMemoryApprovalStore();
    const approvalStore = { save: inner.save.bind(inner), resolve: inner.resolve.bind(inner) };
    const { tool } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail]), tools: [tool], approvalStore });
    const paused = await agent.send('Email Sam');
    expect((await agent.approvals.list()).map((entry) => entry.id)).toEqual([paused.approvalId]);
    expect((await agent.approvals.get(paused.approvalId!))?.id).toBe(paused.approvalId);
  });
});
