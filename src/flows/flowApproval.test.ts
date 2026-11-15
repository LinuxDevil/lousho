/**
 * A durable flow pauses on a `toolCall` awaiting approval, and
 * resume continues once the approval is decided.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { z } from 'zod';
import type { AgentFlow } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowResumeContext } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import type { CheckpointStore } from '../execution/checkpoint';

const flow: AgentFlow = {
  code: 'payout',
  name: 'Payout',
  flow: {
    type: 'sequence',
    steps: [
      { type: 'llmCall', prompt: 'Summarise invoice {{invoice}}', outputVariable: 'summary' },
      { type: 'toolCall', tool: 'pay', arguments: { amount: '{{amount}}' }, outputVariable: 'receipt', retry: { maxAttempts: 3 } },
      { type: 'return', value: '$receipt' },
    ],
  },
};

describe('FlowExecutor approval pause', () => {
  let provider: MockLLMProvider;
  let store: CheckpointStore;
  let pay: Mock<[{ amount: string }], Promise<string>>;
  let approve: Mock<[], 'defer'>;
  let context: FlowExecutionContext;
  let resumeContext: FlowResumeContext;

  beforeEach(() => {
    provider = new MockLLMProvider({ name: 'mock', responses: ['summary'] });
    vi.spyOn(provider, 'generate');
    pay = vi.fn(async ({ amount }: { amount: string }) => `PAID ${amount}`);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(defineTool({ name: 'pay', description: 'Pay', input: z.object({ amount: z.string() }), needsApproval: true, execute: pay }));
    approve = vi.fn(() => 'defer' as const);
    store = memoryStore().checkpoints;
    context = {
      agent: { name: 'flow-agent' },
      provider,
      toolRegistry,
      variables: { invoice: 'inv-1', amount: '900.00' },
      approve,
      checkpointStore: store,
      runId: 'payout-1',
    };
    const { variables: _v, ...rest } = context;
    resumeContext = { ...rest, checkpointStore: store, runId: 'payout-1' };
  });

  it('resumes after a rejection: the step fails with LOUSHO_FLOW_TOOL_DENIED and the approval is used up', async () => {
    const paused = await FlowExecutor.execute(flow, context);
    const approval = { approvalId: paused.approvalId!, approved: false };

    const result = await FlowExecutor.resume(flow, { ...resumeContext, approval });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_TOOL_DENIED' });
    expect(pay).not.toHaveBeenCalled();
    await expect(FlowExecutor.resume(flow, { ...resumeContext, approval: { ...approval, approved: true } })).rejects.toMatchObject({
      code: 'LOUSHO_APPROVAL_NOT_FOUND',
    });
  });

  it('refuses to resume a paused run without the decision, or with another approval id', async () => {
    const paused = await FlowExecutor.execute(flow, context);

    await expect(FlowExecutor.resume(flow, resumeContext)).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    await expect(
      FlowExecutor.resume(flow, { ...resumeContext, approval: { approvalId: 'other', approved: true } })
    ).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
    await expect(FlowExecutor.execute(flow, context)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });

    // Still paused on the same approval.
    expect((await store.load('payout-1'))?.approvalId).toBe(paused.approvalId);
    expect(pay).not.toHaveBeenCalled();
  });
});
