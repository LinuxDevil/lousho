/**
 * Resuming after an approval streams - `streamResumeAfterApproval()`
 * and `agent.approvals.streamResolve()` / `streamAnswer()` return an AgentRun.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { resumeAfterApproval, streamResumeAfterApproval } from './resume';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import type { AgentEvent } from './agentEvents';
import type { AgentRun } from './agentRun';
import { AgentBuilder } from '../core';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import { createAgent } from '../createAgent';
import { mockModel, type MockTurn } from '../testing';

const callEmail: MockTurn = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

function emailTool(execute = async ({ to }: { to: string }) => `sent to ${to}`) {
  return defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
}

/** A paused executor run: the store, registry and provider to resume it with. */
async function pausedRun(script: MockTurn[]) {
  const provider = mockModel(script);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(emailTool());
  const agent = AgentBuilder.create().setName('mailer').addTool('send_email', { tool: 'send_email', options: {} }).build();
  const approvalStore = new InMemoryApprovalStore();
  const paused = await AgentExecutor.execute({ agent, input: 'Email Sam', provider, toolRegistry, approvalStore });
  expect(paused.finishReason).toBe('awaiting-approval');
  return { provider, toolRegistry, approvalStore, id: paused.approvalId! };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

/** Event types, without the per-chunk text deltas. */
const kinds = (events: AgentEvent[]) => events.filter((e) => e.type !== 'text.delta').map((e) => e.type);
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');

describe('streamResumeAfterApproval', () => {
  it('streams the approved call and the continuation in order; the result equals resumeAfterApproval()', async () => {
    const streamed = await pausedRun([callEmail, 'Email sent.']);
    const plain = await pausedRun([callEmail, 'Email sent.']);

    const run = streamResumeAfterApproval({ id: streamed.id, approved: true }, streamed.approvalStore, streamed.toolRegistry, streamed.provider);
    const events = await collect(run);
    const result = await run.result;

    expect(kinds(events)).toEqual(['run.start', 'tool.resume', 'tool.done', 'step.start', 'text.done', 'step.done', 'run.done']);
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ toolCallId: 'call_email', result: 'sent to sam@example.com' });
    expect(text(events)).toBe('Email sent.');
    expect(events.every((e, i) => e.seq === i && e.runId === run.runId)).toBe(true);
    const expected = await resumeAfterApproval({ id: plain.id, approved: true }, plain.approvalStore, plain.toolRegistry, plain.provider);
    expect(result).toEqual(expected);
  });
});

describe('agent.approvals.streamResolve / streamAnswer', () => {

  it('input enqueued on the resumed run reaches the next model call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = mockModel([callEmail, 'Sent, and noted.']);
    const tool = defineTool({ ...emailTool(), execute: async () => gate.then(() => 'sent') });
    const agent = createAgent({ provider: model, tools: [tool] });
    const paused = await agent.send('Email Sam');

    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    expect(run.enqueue('Also cc me.')).toMatchObject({ applied: expect.any(Promise) });
    release();
    const events = await collect(run);

    expect(kinds(events)).toContain('input.applied');
    expect(JSON.stringify(model.lastCall?.messages)).toContain('Also cc me.');
  });
});
