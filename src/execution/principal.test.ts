/**
 * The run's principal reaches tools, `needsApproval` policies,
 * permission rules, hooks and in-process sub-agents; it is kept across an
 * approval pause and a crash; the caller who decides an approval is recorded
 * as the approver (`ctx.approval.by`), never swapped in as the run's principal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { SqliteStore } from '../storage/sqlite';
import { type Principal } from '../auth';
import { PropagatingToolError } from './propagatingToolError';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { PermissionAuditContext, PermissionDecisionEntry } from './permissions';
import type { ToolExecutionContext } from '../types';
import type { AgentEvent } from './agentEvents';

const ALICE: Principal = { id: 'alice', type: 'user', authenticator: 'jwt', issuer: 'https://id.test', claims: { email: 'alice@example.com', roles: ['dev'] } };
const BOB: Principal = { id: 'bob', type: 'user', authenticator: 'jwt', issuer: 'https://id.test' };

/** A tool recording the context of each call; `needsApproval` and `crashOnce` as given. */
function probe(name: string, options: { needsApproval?: boolean; crashOnce?: boolean; mutate?: boolean } = {}) {
  const seen: ToolExecutionContext[] = [];
  const tool = defineTool({
    name,
    description: `Probe ${name}`,
    input: z.object({}),
    ...(options.needsApproval && { needsApproval: true }),
    execute: (_args, ctx) => {
      seen.push(ctx);
      if (options.crashOnce && seen.length === 1) throw new PropagatingToolError(`process died while running ${name}`);
      if (options.mutate && ctx.principal) (ctx.principal as { id: string }).id = 'mallory';
      return `${name} done`;
    },
  });
  return { tool, seen, ids: () => seen.map((ctx) => ctx.principal?.id) };
}

const calling = (...names: string[]): MockTurn => ({ toolCalls: names.map((name) => ({ name, id: `call_${name}` })) });
const task = (agent: string, extra: Record<string, unknown> = {}): MockTurn => ({ toolCalls: [{ name: 'task', id: `task_${agent}`, args: { agent, prompt: 'do it', description: `${agent} task`, ...extra } }] });

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the principal in tools, policies and permission rules', () => {

  it('needsApproval, permission rules, tool-call hooks and the audit callback receive it; events and the audit entry do not', async () => {
    const checks: Array<string | undefined> = [];
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({}),
      // Ask only callers without an `admin` claim.
      needsApproval: (_args, ctx) => (checks.push(`policy:${ctx.principal?.id}`), ctx.principal?.claims?.admin !== true),
      execute: () => 'deployed',
    });
    const audit: Array<[PermissionDecisionEntry, PermissionAuditContext]> = [];
    const agent = createAgent({
      provider: mockModel([calling('deploy'), 'done', calling('deploy')]),
      tools: [deploy],
      permissions: [{ tool: 'deploy', when: (_args, ctx) => (checks.push(`rule:${ctx.principal?.id}`), ctx.principal?.type === 'service'), action: 'deny' }],
      hooks: [{ name: 'audit', preToolCall: (ctx) => void checks.push(`hook:${ctx.principal?.id}`) }],
      onPermissionDecision: (entry, ctx) => audit.push([entry, ctx]),
    });

    const admin: Principal = { ...ALICE, claims: { admin: true } };
    const events = await collect(agent.stream('deploy', { principal: admin }));
    const paused = await agent.send('deploy', { principal: BOB });

    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(checks).toEqual(['hook:alice', 'rule:alice', 'policy:alice', 'hook:bob', 'rule:bob', 'policy:bob']);
    expect(audit.map(([, ctx]) => ctx.principal?.id)).toEqual(['alice', 'bob']);
    expect(audit.every(([entry]) => !('principal' in entry))).toBe(true);
    // No caller identity in the event stream: not on permission.decision, not anywhere.
    expect(JSON.stringify(events)).not.toContain('alice');
  });
});

describe('sub-agents', () => {

  it('a paused sub-agent call resumed by another caller runs for the lead caller, with the decider as approver', async () => {
    const deploy = probe('deploy', { needsApproval: true });
    const researcher = createAgent({ provider: mockModel([calling('deploy'), 'deployed']), tools: [deploy.tool], description: 'Deploys' });
    const lead = createAgent({ provider: mockModel([task('researcher'), 'all done']), subagents: { researcher } });

    const paused = await lead.send('deploy it', { principal: ALICE });
    const [pending] = await lead.approvals.list();
    expect(pending).toMatchObject({ subagentPath: ['researcher'], principal: { id: 'alice' } });

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true }, { principal: BOB });

    expect(result.text).toBe('all done');
    expect(deploy.seen[0].principal?.id).toBe('alice');
    expect(deploy.seen[0].approval?.by?.id).toBe('bob');
  });
});

describe('pause and resume', () => {

  it('the approval survives a restart: a new agent resolves it and the run still acts for A', async () => {
    const records = new Map<string, string>();
    // A JSON round-trip, like any durable approval store.
    const approvalStore: ApprovalStore = {
      save: async (pending, snapshot) => void records.set(pending.id, JSON.stringify({ pending, snapshot })),
      resolve: async (id) => {
        const record = records.get(id);
        records.delete(id);
        return record ? (JSON.parse(record) as { pending: PendingApproval; snapshot: ExecutionSnapshot }) : null;
      },
    };
    const send = probe('send_email', { needsApproval: true });
    const paused = await createAgent({ provider: mockModel([calling('send_email')]), tools: [send.tool], approvalStore }).send('email', { principal: ALICE });

    const restarted = createAgent({ provider: mockModel(['sent']), tools: [send.tool], approvalStore });
    const result = await restarted.approvals.answer({ id: paused.approvalId!, answer: 'ok' }, { principal: BOB });

    expect(result.text).toBe('sent');
    expect(send.seen[0].principal).toEqual(ALICE);
    expect(send.seen[0].approval).toEqual({ id: expect.any(String), note: 'ok', by: BOB });
  });

  it('a crashed checkpointed run (SqliteStore on disk) finished by agent.resume() in a new agent runs its tools for the original principal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-n10b-'));
    temps.push(dir);
    const file = join(dir, 'agent.db');
    const a = probe('a');
    const b = probe('b', { crashOnce: true });
    const crashing = new SqliteStore(file);
    const first = createAgent({ provider: mockModel([calling('a'), calling('b')]), tools: [a.tool, b.tool], store: crashing });
    await expect(first.send('run the job', { sessionId: 'job-1', principal: ALICE })).rejects.toThrow('process died');
    crashing.close();

    const reopened = new SqliteStore(file);
    try {
      expect((await reopened.checkpoints.load('job-1'))?.principal).toEqual(ALICE);
      const agent = createAgent({ provider: mockModel(['finished']), tools: [a.tool, b.tool], store: reopened });
      // Another caller may not continue it.
      await expect(agent.send('and more', { sessionId: 'job-1', principal: BOB })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
      const result = await agent.resume('job-1');

      expect(result?.text).toBe('finished');
      expect(a.ids()).toEqual(['alice']);
      expect(b.ids()).toEqual(['alice', 'alice']);
    } finally {
      reopened.close();
    }
  });
});
