/**
 * Permission modes - `plan`, `acceptEdits` and `dontAsk` as presets over
 * the permission rules and `needsApproval`, applied after them in the gate.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { createFsTools } from '../tools/workspace/fsTools';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent } from './agentEvents';
import {
  allow,
  deny,
  DONT_ASK_REASON,
  PLAN_MODE_REASON,
  type PermissionDecisionEntry,
  type PermissionMode,
  type PermissionModeChange,
} from './permissions';

/** A tool that records its calls. */
function tool(name: string, options: { needsApproval?: boolean; readOnly?: boolean; editsFiles?: boolean } = {}) {
  const calls: unknown[] = [];
  const defined = defineTool({
    name,
    description: `The ${name} tool`,
    input: z.object({ value: z.string().optional() }),
    needsApproval: options.needsApproval,
    editsFiles: options.editsFiles,
    ...(options.readOnly && { annotations: { readOnlyHint: true } }),
    execute: async () => {
      calls.push(name);
      return `${name} ran`;
    },
  });
  return { defined, calls };
}

/** One of each kind of tool the mode table distinguishes. */
function toolbox() {
  return {
    peek: tool('peek', { readOnly: true }),
    patch: tool('patch', { needsApproval: true, editsFiles: true }),
    deploy: tool('deploy', { needsApproval: true }),
    ping: tool('ping'),
    notify: tool('notify', { needsApproval: true }),
    rm: tool('rm'),
  };
}

const RULES = [allow('notify'), deny('rm', 'No deletes')];

type Outcome = 'ran' | 'paused' | 'denied by rule' | 'denied by plan' | 'denied by dontAsk';

/** The first tool result the model saw, parsed (undefined when the run paused before the second call). */
function firstToolResult(model: MockModel): Record<string, unknown> | undefined {
  const message = model.calls[1]?.messages.find((m) => m.role === 'tool');
  return message && (JSON.parse(String(message.content)) as Record<string, unknown>);
}

/** Runs one call of `toolName` under `mode` and says what became of it. */
async function outcomeOf(mode: PermissionMode, toolName: string): Promise<{ outcome: Outcome; entries: PermissionDecisionEntry[] }> {
  const tools = toolbox();
  const entries: PermissionDecisionEntry[] = [];
  const args = toolName === 'ask_question' ? { question: 'Which file?' } : {};
  const model = mockModel([{ toolCalls: [{ name: toolName, id: 'c1', args }] }, 'done']);
  const agent = createAgent({
    provider: model,
    tools: Object.values(tools).map((t) => t.defined),
    askQuestion: true,
    permissions: RULES,
    permissionMode: mode,
    onPermissionDecision: (entry) => entries.push(entry),
  });
  const result = await agent.send('go');
  if (result.finishReason === 'awaiting-approval') return { outcome: 'paused', entries };
  const ran = Object.values(tools).some((t) => t.calls.length > 0);
  if (ran) return { outcome: 'ran', entries };
  const toolResult = firstToolResult(model);
  expect(toolResult).toMatchObject({ kind: 'denied' });
  const reason = toolResult?.reason;
  const outcome: Outcome = reason === PLAN_MODE_REASON ? 'denied by plan' : reason === DONT_ASK_REASON ? 'denied by dontAsk' : 'denied by rule';
  return { outcome, entries };
}

const TABLE: Record<PermissionMode, Record<string, Outcome>> = {
  default: {
    peek: 'ran',
    patch: 'paused',
    deploy: 'paused',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  plan: {
    peek: 'ran',
    patch: 'denied by plan',
    deploy: 'denied by plan',
    ping: 'denied by plan',
    notify: 'denied by plan',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  acceptEdits: {
    peek: 'ran',
    patch: 'ran',
    deploy: 'paused',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  dontAsk: {
    peek: 'ran',
    patch: 'denied by dontAsk',
    deploy: 'denied by dontAsk',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'denied by dontAsk',
  },
};

const CASES = Object.entries(TABLE).flatMap(([mode, row]) => Object.entries(row).map(([toolName, outcome]) => [mode, toolName, outcome] as const));

describe('permission modes', () => {
  it.each(CASES)('%s mode: a call of %s is %s', async (mode, toolName, expected) => {
    const { outcome } = await outcomeOf(mode as PermissionMode, toolName);
    expect(outcome).toBe(expected);
  });
});

describe('permission modes in sessions', () => {
  it("starts in plan; setPermissionMode('acceptEdits') from a tool.start listener applies to the next write_file of the same turn", async () => {
    const workspace = new MemoryWorkspace({ files: { 'notes.md': '# Notes\n' } });
    const changes: PermissionModeChange[] = [];
    const agent = createAgent({
      provider: mockModel([
        { toolCalls: [{ name: 'write_file', id: 'w1', args: { path: 'early.md', content: 'x' } }] },
        { toolCalls: [{ name: 'read_file', id: 'r1', args: { path: 'notes.md' } }] },
        { toolCalls: [{ name: 'write_file', id: 'w2', args: { path: 'plan.md', content: 'the plan' } }] },
        'done',
      ]),
      tools: createFsTools(workspace, { needsApproval: { write_file: true } }),
      onPermissionModeChange: (change) => changes.push(change),
    });
    const session = agent.session({ permissionMode: 'plan' });
    expect(session.permissionMode).toBe('plan');
    const run = session.stream('Plan, then write the plan.');
    for await (const event of run) {
      if (event.type === 'tool.start' && event.toolName === 'read_file') session.setPermissionMode('acceptEdits');
    }
    const result = await run.result;

    expect(result.finishReason).toBe('stop');
    expect(Object.keys(workspace.snapshot())).not.toContain('early.md');
    expect(await workspace.readFile('plan.md')).toBe('the plan');
    expect(session.permissionMode).toBe('acceptEdits');
    expect(changes).toEqual([{ sessionId: session.id, from: 'plan', to: 'acceptEdits', at: expect.any(String) }]);
  });

  it('a throwing session.on() listener does not break the turn', async () => {
    const agent = createAgent({ provider: mockModel(['hi']), onEvent: () => undefined });
    const session = agent.session();
    session.on(() => {
      throw new Error('listener bug');
    });
    const other: AgentEvent[] = [];
    session.on((event) => other.push(event));

    const result = await session.send('Hello');

    expect(result.text).toBe('hi');
    expect(other.at(-1)).toMatchObject({ type: 'run.done' });
  });

  it('a call approved before a switch to plan mode is refused when the turn continues', async () => {
    const { deploy } = toolbox();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, 'done']);
    const entries: PermissionDecisionEntry[] = [];
    const agent = createAgent({ provider: model, tools: [deploy.defined], onPermissionDecision: (entry) => entries.push(entry) });
    const session = agent.session();
    const paused = await session.send('Deploy.');
    session.setPermissionMode('plan');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.finishReason).toBe('stop');
    expect(deploy.calls).toEqual([]);
    expect(firstToolResult(model)).toMatchObject({ kind: 'denied', reason: PLAN_MODE_REASON });
    expect(entries.at(-1)).toMatchObject({ toolName: 'deploy', decision: 'deny', mode: 'plan' });
  });

  it("a run paused outside a session continues under the agent's mode, not the send() call's", async () => {
    const { deploy } = toolbox();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, { toolCalls: [{ name: 'deploy', id: 'd2' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [deploy.defined], permissionMode: 'dontAsk' });
    const paused = await agent.send('Deploy twice.', { permissionMode: 'default' });
    expect(paused.finishReason).toBe('awaiting-approval');

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.finishReason).toBe('stop');
    expect(deploy.calls).toEqual(['deploy']);
    const second = model.calls[2].messages.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.parse(String(second?.content))).toMatchObject({ kind: 'denied', reason: DONT_ASK_REASON });
  });
});
