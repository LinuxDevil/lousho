/**
 * A child agent run (the `task` tool) inherits the parent run's
 * runtime.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import { resumeAfterApproval } from './resume';
import type { ApprovalStore, ResolvedApproval } from './ApprovalGate';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { SessionAwaitingApprovalError } from './errors';

const lead = { name: 'lead', prompt: 'You coordinate.' };

const task = (agent: string, prompt = 'do it', id = `${agent}-call`) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task` },
  id,
});

/** A JSON round-tripping store, so snapshots must survive serialization. */
function memoryApprovals() {
  const records = new Map<string, string>();
  const store: ApprovalStore = {
    save: async (pending, snapshot) => {
      records.set(pending.id, JSON.stringify({ pending, snapshot }));
    },
    resolve: async (id) => {
      const record = records.get(id);
      records.delete(id);
      return record ? (JSON.parse(record) as ResolvedApproval) : null;
    },
  };
  const only = (): ResolvedApproval => {
    expect(records.size).toBe(1);
    return JSON.parse([...records.values()][0]) as ResolvedApproval;
  };
  return { store, records, only };
}

/** A sub-agent with a `send` tool that needs approval; `sent` counts executions. */
function approvingChild(name: string, turns: MockTurn[]) {
  const sent: string[] = [];
  const send = defineTool({
    name: 'send',
    description: 'Sends a message',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute: ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
  const model = mockModel(turns);
  const agent = createAgent({ name, provider: model, tools: [send], description: `The ${name}` });
  return { agent, model, sent };
}

function toolResults(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.role === 'tool');
}

function run(options: Omit<ExecuteOptions, 'agent' | 'input'> & { input?: string }) {
  return AgentExecutor.execute({ agent: lead, input: 'go', ...options });
}

describe('approval inside a sub-agent', () => {

  it('when two sub-agents pause in one turn, pauses on the first and tells the model the second did not run', async () => {
    const approvals = memoryApprovals();
    const first = approvingChild('first', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }, 'first sent']);
    const second = approvingChild('second', [{ toolCalls: [{ name: 'send', args: { to: 'bo' } }] }, 'second sent']);
    const leadModel = mockModel([{ toolCalls: [task('first'), task('second')] }, 'done']);
    const options = { subagents: { first: first.agent, second: second.agent } };

    const paused = await run({ provider: leadModel, ...options, approvalStore: approvals.store });

    expect(approvals.only().pending.subagentPath).toEqual(['first']);
    const secondResult = toolResults(paused.messages)[1];
    expect(secondResult.isError).toBe(true);
    expect(secondResult.content).toContain("Sub-agent 'second' needed approval to run 'send'");
    expect(JSON.parse(secondResult.content as string)).toMatchObject({ error: 'ToolNotRunError', kind: 'not-run', toolName: 'task' });

    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(first.sent).toEqual(['ana']);
    expect(second.sent).toEqual([]);
  });

  it('without an approval store, the child call becomes an error result and nothing runs', async () => {
    const { agent: researcher, sent } = approvingChild('researcher', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }]);

    const result = await run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher } });

    expect(sent).toEqual([]);
    const [taskResult] = toolResults(result.messages);
    expect(taskResult.isError).toBe(true);
    expect(taskResult.content).toContain('requires approval but no approvalStore');
  });
});

describe('durable sessions with sub-agents', () => {
  function checkpoints() {
    const data = new Map<string, string>();
    const store = new KVCheckpointStore({
      get: async (key) => data.get(key) ?? null,
      put: async (key, value) => {
        data.set(key, value);
      },
      delete: async (key) => {
        data.delete(key);
      },
    });
    return store;
  }

  it('keeps the session awaiting approval when the resumed sub-agent pauses again', async () => {
    const approvals = memoryApprovals();
    const checkpointStore = checkpoints();
    const { agent: researcher, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      { toolCalls: [{ name: 'send', args: { to: 'bo' } }] },
      'both sent',
    ]);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);
    const options = { subagents: { researcher } };
    const session = { sessionId: 's-2', checkpointStore };

    const first = await run({ provider: leadModel, ...options, ...session, approvalStore: approvals.store });
    const resume = (id: string) =>
      resumeAfterApproval({ id, approved: true }, approvals.store, new ToolRegistry(), leadModel, options, checkpointStore);
    const second = await resume(first.approvalId!);

    expect(second.finishReason).toBe('awaiting-approval');
    expect(await checkpointStore.load('s-2')).toMatchObject({ status: 'awaiting-approval', approvalId: second.approvalId });
    await expect(run({ provider: leadModel, ...options, ...session })).rejects.toBeInstanceOf(SessionAwaitingApprovalError);

    const done = await resume(second.approvalId!);

    expect(sent).toEqual(['ana', 'bo']);
    expect(done.text).toBe('done');
    expect(await checkpointStore.load('s-2')).toMatchObject({ status: 'finished' });
  });

  it('a task call of a step paused on an approval runs at once; its sub-agent pause follows the decision', async () => {
    const approvals = memoryApprovals();
    const confirmed: string[] = [];
    const confirm = defineTool({
      name: 'confirm',
      description: 'Confirms',
      input: z.object({}),
      needsApproval: true,
      execute: (_args, ctx) => {
        confirmed.push(ctx.toolCallId);
        return 'confirmed';
      },
    });
    const registry = new ToolRegistry();
    registry.registerMany([confirm]);
    const { agent: researcher, model: childModel, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      'sent',
    ]);
    const leadModel = mockModel([{ toolCalls: [{ name: 'confirm', id: 'confirm-call' }, task('researcher')] }, 'done']);
    const options = { subagents: { researcher } };
    const agent = { ...lead, tools: { confirm: { tool: 'confirm' } } };

    const first = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: leadModel,
      toolRegistry: registry,
      ...options,
      approvalStore: approvals.store,
    });
    expect(approvals.only().snapshot.remainingToolCalls).toEqual([]);
    expect(approvals.only().snapshot.heldSubagent).toMatchObject({ toolCallId: 'researcher-call', agentName: 'researcher' });
    expect(childModel.calls).toHaveLength(1);
    expect(sent).toEqual([]);

    const second = await resumeAfterApproval({ id: first.approvalId!, approved: true }, approvals.store, registry, leadModel, options);

    expect(confirmed).toEqual(['confirm-call']);
    expect(second.finishReason).toBe('awaiting-approval');
    expect(approvals.only().pending).toMatchObject({ toolName: 'send', subagentPath: ['researcher'] });

    const done = await resumeAfterApproval({ id: second.approvalId!, approved: true }, approvals.store, registry, leadModel, options);

    expect(sent).toEqual(['ana']);
    expect(done.text).toBe('done');
    expect(leadModel.calls).toHaveLength(2);
    expect(toolResults(done.messages).map((m) => m.toolCallId)).toEqual(['confirm-call', 'researcher-call']);
    expect(toolResults(done.messages)[1].content).toContain('sent');
  });
});
