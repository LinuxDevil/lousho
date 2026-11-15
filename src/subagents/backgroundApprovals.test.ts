/** A background sub-agent paused for approval pauses the lead when the lead awaits it, and resumes with the decision. */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn, type MockTurnObject } from '../testing';
import type { Message } from '../providers';
import type { AgentEvent } from '../execution/agentEvents';

const bgCall = (agent: string) => ({ name: 'task', args: { agent, prompt: 'fix the bug', description: `${agent} task`, background: true } });
const bgTask = (agent: string): MockTurnObject => ({ toolCalls: [bgCall(agent)] });
const awaitTasks = (...taskIds: string[]): MockTurnObject => ({
  toolCalls: [{ name: 'agent_await', args: taskIds.length === 1 ? { taskId: taskIds[0] } : { taskIds } }],
});
const shellCall = (cmd: string): MockTurnObject => ({ toolCalls: [{ name: 'shell', args: { cmd } }] });

/** A coding sub-agent whose `shell` tool needs approval; `turns` are its model's. */
function coder(turns: MockTurn[], description = 'Writes code') {
  const ran: string[] = [];
  const shell = defineTool({
    name: 'shell',
    description: 'Runs a shell command',
    input: z.object({ cmd: z.string() }),
    needsApproval: true,
    execute: ({ cmd }) => (ran.push(cmd), `ran ${cmd}`),
  });
  const model = mockModel(turns);
  return { ran, model, agent: createAgent({ provider: model, instructions: 'You code.', tools: [shell], description }) };
}

/** The parsed results of the lead's tool calls named `name`, in order. */
function results(messages: readonly Message[], name: string): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === name)
    .map((m) => JSON.parse(m.content as string) as Record<string, unknown>);
}

describe('background sub-agents that need approval', () => {

  it('a child that pauses twice: two approvals in sequence, both resolvable', async () => {
    const child = coder([shellCall('npm ci'), shellCall('npm test'), 'all green']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'done']), subagents: { coder: child.agent } });

    const first = await lead.send('go');
    const second = await lead.approvals.resolve({ id: first.approvalId!, approved: true });

    expect(second.finishReason).toBe('awaiting-approval');
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ id: second.approvalId, args: { cmd: 'npm test' }, subagentPath: ['coder'] })]);

    const result = await lead.approvals.resolve({ id: second.approvalId!, approved: true });

    expect(child.ran).toEqual(['npm ci', 'npm test']);
    expect(results(result.messages, 'agent_await')[0]).toMatchObject({ status: 'done', result: expect.stringMatching(/^all green/) });
    expect(result.text).toBe('done');
  });

  it('two awaited tasks both paused: two approvals in sequence, then one agent_await result with both answers', async () => {
    const backend = coder([shellCall('make api'), 'api built'], 'Builds the API');
    const frontend = coder([shellCall('make ui'), 'ui built'], 'Builds the UI');
    const leadModel = mockModel([{ toolCalls: [bgCall('backend'), bgCall('frontend')] }, awaitTasks('task_1', 'task_2'), 'done']);
    const lead = createAgent({ provider: leadModel, subagents: { backend: backend.agent, frontend: frontend.agent } });

    const first = await lead.send('go');
    expect(first.backgroundTasks?.map((t) => t.status)).toEqual(['awaiting-approval', 'awaiting-approval']);
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ args: { cmd: 'make api' }, subagentPath: ['backend'] })]);

    const second = await lead.approvals.resolve({ id: first.approvalId!, approved: true });
    expect(second.finishReason).toBe('awaiting-approval');
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ id: second.approvalId, args: { cmd: 'make ui' }, subagentPath: ['frontend'] })]);
    expect(backend.ran).toEqual(['make api']);
    expect(frontend.ran).toEqual([]);

    const result = await lead.approvals.resolve({ id: second.approvalId!, approved: true });

    expect(frontend.ran).toEqual(['make ui']);
    const [awaited] = results(result.messages, 'agent_await');
    expect((awaited.tasks as { taskId: string; status: string; result: string }[]).map((t) => [t.taskId, t.status, t.result.split('\n')[0]])).toEqual([
      ['task_1', 'done', 'api built'],
      ['task_2', 'done', 'ui built'],
    ]);
    // The lead model was called once after the decisions, with both answers.
    expect(leadModel.calls).toHaveLength(3);
  });

  it('streams: agent.stream() reports approval.requested, and approvals.streamResolve() streams the continuation', async () => {
    const child = coder([shellCall('npm test'), 'tests pass']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'all done']), subagents: { coder: child.agent } });

    const run = lead.stream('go');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);
    const paused = await run.result;
    expect(events.filter((e) => e.type === 'approval.requested')).toEqual([
      expect.objectContaining({ approvalId: paused.approvalId, toolName: 'shell', args: { cmd: 'npm test' } }),
    ]);

    const resumed = lead.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const continued: AgentEvent[] = [];
    for await (const event of resumed) continued.push(event);
    const result = await resumed.result;

    expect(child.ran).toEqual(['npm test']);
    expect(result.text).toBe('all done');
    const awaited = continued.find((e) => e.type === 'tool.done' && e.toolName === 'agent_await');
    expect(JSON.stringify(awaited)).toContain('tests pass');
    // The resumed child reports under the re-entered agent_await call.
    const childEvents = continued.filter((e) => e.subagent?.name === 'coder');
    expect(childEvents.map((e) => e.type)).toContain('tool.done');
    expect(new Set(childEvents.map((e) => e.subagent?.toolCallId))).toEqual(new Set([awaited?.type === 'tool.done' && awaited.toolCallId]));
    expect(continued.map((e) => e.type)).toContain('text.delta');
    expect(continued.at(-1)?.type).toBe('run.done');
  });
});
