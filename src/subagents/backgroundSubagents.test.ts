import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers';
import { subagentOptionsOf, withSubagentOptions } from './backgroundTasks';
import { AgentExecutor } from '../execution/AgentExecutor';
import type { AgentEvent } from '../execution/agentEvents';
import type { AgentConfig } from '../types';

const bgTask = (agent: string, prompt: string) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task`, background: true },
});

/** The parsed results of the lead's tool calls named `name`, in order. */
function results(messages: readonly Message[], name: string): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === name)
    .map((m) => JSON.parse(m.content as string) as Record<string, unknown>);
}

/** A child tool that blocks until `release()` or until its run is aborted. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => (onAbort = resolve));
  let onEnter!: () => void;
  const entered = new Promise<void>((resolve) => (onEnter = resolve));
  const tool = defineTool({
    name: 'wait',
    description: 'Waits',
    input: z.object({}),
    execute: (_args, ctx) =>
      new Promise<string>((resolve, reject) => {
        onEnter();
        void opened.then(() => resolve('waited'));
        ctx.abortSignal?.addEventListener('abort', () => {
          onAbort();
          reject(new Error('aborted'));
        });
      }),
  });
  return { tool, release, aborted, entered };
}

/** A sub-agent that calls `wait` once, then answers with `answer` (`#n` for its n-th run). */
function waitingChild(tool: ReturnType<typeof gate>['tool'], answer = 'answer') {
  let runs = 0;
  const turn: MockTurn = (req) =>
    req.messages.at(-1)?.role === 'tool' ? `${answer} #${runs}` : (runs++, { toolCalls: [{ name: 'wait' }] });
  return createAgent({ provider: mockModel([turn], { onExhausted: 'repeat-last' }), tools: [tool], description: 'Researches' });
}

describe('background sub-agents', () => {

  it('agent_await times out on a running task, and agent_cancel stops it', async () => {
    const { tool, aborted } = gate();
    const lead = createAgent({
      provider: mockModel([
        { toolCalls: [bgTask('researcher', 'a')] },
        { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1', timeoutMs: 5 } }] },
        { toolCalls: [{ name: 'agent_cancel', args: { taskId: 'task_1' } }] },
        { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] },
        'done',
      ]),
      subagents: { researcher: waitingChild(tool) },
    });

    const result = await lead.send('go');

    expect(results(result.messages, 'agent_await').map((r) => r.status)).toEqual(['timeout', 'cancelled']);
    expect(results(result.messages, 'agent_cancel')[0]).toMatchObject({ taskId: 'task_1', status: 'cancelled' });
    await aborted;
  });

  it('reports a sub-agent paused for approval as awaiting-approval, with its approvalId (without agent_await)', async () => {
    let ran = false;
    let asked!: () => void;
    const approvalAsked = new Promise<void>((resolve) => (asked = resolve));
    const needsApproval = () => (asked(), true);
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval, execute: () => (ran = true) });
    const researcher = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy' }] }]), tools: [deploy], description: 'Deploys' });
    // The child's pause settles a few async steps after its approval is asked for, and how long that takes
    // depends on machine load (#330), so ask again until the task has left `running` (no fixed sleep).
    const statusOncePaused: MockTurn = async (req) => {
      await approvalAsked;
      const last = req.messages.at(-1);
      const seen = last?.role === 'tool' && last.toolName === 'agent_status' ? (JSON.parse(last.content as string) as { tasks: { status: string }[] }) : undefined;
      if (seen && seen.tasks[0]?.status !== 'running') return 'done';
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { toolCalls: [{ name: 'agent_status', args: { taskId: 'task_1' } }] };
    };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'ship it')] }, statusOncePaused], { onExhausted: 'repeat-last' }),
      subagents: { researcher },
    });

    const result = await lead.send('go');

    const status = results(result.messages, 'agent_status').at(-1)!;
    expect(status.tasks).toEqual([expect.objectContaining({ status: 'awaiting-approval', toolName: 'deploy', approvalId: expect.any(String) })]);
    expect(ran).toBe(false);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('done');
    // Never awaited: reported at the end, and not resumable (no approval of the lead).
    expect(result.backgroundTasks).toEqual([expect.objectContaining({ status: 'awaiting-approval' })]);
    expect(await lead.approvals.list()).toEqual([]);
  });

  it('reports unknown task ids and bad options', async () => {
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'agent_cancel', args: { taskId: 'task_9' } }] }, 'ok']),
      subagents: { researcher: createAgent({ provider: mockModel([]), description: 'Researches' }) },
    });
    const [message] = (await lead.send('go')).messages.filter((m) => m.role === 'tool');
    expect(message.isError).toBe(true);
    expect(message.content).toContain("Unknown background task 'task_9'");
    expect(() => withSubagentOptions({}, { maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});

describe('background sub-agents at the end of the lead run', () => {
  const statuses = (tasks: readonly { status: string }[] | undefined) => tasks?.map((t) => t.status);

  it('cancels queued and running background sub-agents when the lead finishes, before the run resolves', async () => {
    const { tool, aborted, entered } = gate();
    const events: AgentEvent[] = [];
    const agent: AgentConfig = { id: 'lead', name: 'Lead', prompt: 'p' };
    const finishOnceRunning = async () => (await entered, 'done');
    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a'), bgTask('researcher', 'b')] }, finishOnceRunning]),
      subagents: withSubagentOptions({ researcher: waitingChild(tool) }, { maxConcurrent: 1 }),
      onAgentEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('done');
    expect(result.backgroundTasks).toEqual([
      { taskId: 'task_1', agent: 'researcher', status: 'cancelled', elapsedMs: expect.any(Number) },
      { taskId: 'task_2', agent: 'researcher', status: 'cancelled', elapsedMs: expect.any(Number) },
    ]);
    await aborted;
    // The running child has wound down by then: its last event came before the lead's run.done.
    expect(events.some((e) => e.subagent?.name === 'researcher')).toBe(true);
    const lastChildIndex = events.reduce((last, e, i) => (e.subagent ? i : last), -1);
    const leadDoneIndex = events.findIndex((e) => e.type === 'run.done' && !e.subagent);
    expect(lastChildIndex).toBeGreaterThanOrEqual(0);
    expect(lastChildIndex).toBeLessThan(leadDoneIndex);
    const seen = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(seen);
  });

  it('createAgent({ subagentOptions }) is forwarded over withSubagentOptions(), without changing the subagents value', async () => {
    const { tool, release } = gate();
    const subagents = withSubagentOptions({ researcher: waitingChild(tool) }, { maxConcurrent: 3, awaitBackgroundOnFinish: true });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a'), bgTask('researcher', 'b')] }, () => (release(), 'done')]),
      subagents,
      subagentOptions: { maxConcurrent: 1 },
    });

    const result = await lead.send('go');

    expect(results(result.messages, 'task').map((r) => r.status)).toEqual(['running', 'queued']);
    expect(statuses(result.backgroundTasks)).toEqual(['done', 'done']);
    expect(subagentOptionsOf(subagents)).toEqual({ maxConcurrent: 3, awaitBackgroundOnFinish: true });
  });
});
