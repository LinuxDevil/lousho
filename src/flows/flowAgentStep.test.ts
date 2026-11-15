/**
 * The 'agent' flow step: sends the interpolated input to the createAgent()
 * agent the flow context's `agents` map holds under the step's `agent` name,
 * and stores its reply text in `outputVariable`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowStepAgent } from './FlowExecutor';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';

function flowOf(root: EditorStep, code = 'agent-flow'): AgentFlow {
  return { code, name: 'Agent Flow', flow: root };
}

function context(extra: Partial<FlowExecutionContext> = {}): FlowExecutionContext {
  return {
    agent: { name: 'flow-agent' },
    provider: mockModel(['unused']),
    variables: { topic: 'cats' },
    ...extra,
  };
}

describe('FlowExecutor agent step', () => {

  it('fails with LOUSHO_FLOW_INVALID naming the available agents when the name is unknown', async () => {
    const writer = createAgent({ provider: mockModel(['A draft.']) });
    const flow = flowOf({ type: 'agent', agent: 'missing' });

    const result = await FlowExecutor.execute(flow, context({ agents: { writer } }));

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    expect(result.error?.message).toContain("no agent 'missing'");
    expect(result.error?.message).toContain('writer');
  });

  it("reports 'none' when the context has no agents at all", async () => {
    const result = await FlowExecutor.execute(flowOf({ type: 'agent', agent: 'missing' }), context());

    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    expect(result.error?.message).toContain('(have: none)');
  });

  it('fails the step with LOUSHO_FLOW_EXECUTION_FAILED when the agent pauses for an approval', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const tool = defineTool({
      name: 'send_email',
      description: 'Sends an email',
      input: z.object({ to: z.string() }),
      needsApproval: true,
      execute,
    });
    const pauser = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] }]),
      tools: [tool],
    });
    const flow = flowOf({ type: 'agent', agent: 'pauser' });

    const result = await FlowExecutor.execute(flow, context({ agents: { pauser } }));

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_EXECUTION_FAILED' });
    expect(result.error?.message).toContain("agent step 'pauser' paused for an approval");
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not call a completed agent step again when a durable run resumes', async () => {
    const checkpointStore = memoryStore().checkpoints;
    const first: FlowStepAgent = { send: vi.fn(async () => ({ text: 'A draft.', finishReason: 'stop' })) };
    const secondSend = vi
      .fn<Parameters<FlowStepAgent['send']>, ReturnType<FlowStepAgent['send']>>()
      .mockRejectedValueOnce(new Error('service down'))
      .mockResolvedValueOnce({ text: 'B reply.', finishReason: 'stop' });
    const second: FlowStepAgent = { send: secondSend };
    const flow = flowOf({
      type: 'sequence',
      steps: [
        { type: 'agent', agent: 'first', outputVariable: 'draft' },
        { type: 'agent', agent: 'second', outputVariable: 'reply' },
        { type: 'return', value: '$reply' },
      ],
    });
    const runContext = context({ agents: { first, second }, checkpointStore, runId: 'run-1' });

    const failed = await FlowExecutor.execute(flow, runContext);
    expect(failed.success).toBe(false);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(1);

    const { variables: _ignored, ...rest } = runContext;
    const resumed = await FlowExecutor.resume(flow, { ...rest, checkpointStore, runId: 'run-1' });

    expect(resumed).toMatchObject({ success: true, output: 'B reply.' });
    expect(resumed.variables.draft).toBe('A draft.');
    // The completed agent step was skipped; only the failed one ran again.
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(2);
  });

  it("still rejects the editor-only 'step' shape, now pointing at 'agent' steps", async () => {
    const writer = createAgent({ provider: mockModel(['A draft.']) });
    const flow = flowOf({ type: 'step', agent: 'writer', input: 'Write about {{topic}}' });

    const result = await FlowExecutor.execute(flow, context({ agents: { writer } }));

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    expect(result.error?.message).toContain("{ type: 'agent', agent, input }");
  });
});
