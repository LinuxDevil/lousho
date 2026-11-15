/**
 * Durable flow runs - checkpoint after each node, resume skips
 * the completed ones.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { memoryStore } from '../storage/agentStore';
import type { CheckpointStore } from '../execution/checkpoint';

function flowOf(root: EditorStep, code = 'durable'): AgentFlow {
  return { code, name: 'Durable', flow: root };
}

describe('FlowExecutor durability', () => {
  let provider: MockLLMProvider;
  let toolRegistry: ToolRegistry;
  let store: CheckpointStore;
  let flakyCalls: number;
  let failFlaky: boolean;
  let context: FlowExecutionContext;

  beforeEach(() => {
    provider = new MockLLMProvider({ name: 'mock', responses: ['one', 'two', 'three', 'four'] });
    vi.spyOn(provider, 'generate');
    toolRegistry = new ToolRegistry();
    flakyCalls = 0;
    failFlaky = true;
    toolRegistry.register('flaky', {
      displayName: 'Flaky',
      tool: {
        description: 'Fails while failFlaky is set',
        parameters: z.object({}),
        execute: async () => {
          flakyCalls++;
          if (failFlaky) throw new Error('service down');
          return 'ok';
        },
      },
    });
    store = memoryStore().checkpoints;
    context = {
      agent: { name: 'flow-agent' },
      provider,
      toolRegistry,
      variables: { topic: 'cats' },
      checkpointStore: store,
      runId: 'run-1',
    };
  });

  it('saves no checkpoint when the inputs are invalid, and a resume of an unknown run names execute(), not forking', async () => {
    const flow: AgentFlow = { ...flowOf({ type: 'return', value: 'x' }), inputs: [{ name: 'order', type: 'shortText', required: true }] };
    expect((await FlowExecutor.execute(flow, context)).success).toBe(false);
    expect(await store.load('run-1')).toBeNull();

    const { variables: _ignored, ...rest } = context;
    const error = await FlowExecutor.resume(flow, { ...rest, checkpointStore: store, runId: 'run-1' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'LOUSHO_CHECKPOINT_NOT_FOUND' });
    const { hint } = error as { hint?: string };
    expect(hint).toMatch(/FlowExecutor\.execute/);
    expect(hint).not.toMatch(/fork/i);
  });

  it('refuses to resume with a flow whose steps changed, but not one whose prompts did', async () => {
    const ask: EditorStep = { type: 'llmCall', prompt: 'about {{topic}}', outputVariable: 'first' };
    const steps: EditorStep[] = [ask, { type: 'toolCall', tool: 'flaky', arguments: {} }];
    expect((await FlowExecutor.execute(flowOf({ type: 'sequence', steps }), context)).success).toBe(false);
    const { variables: _ignored, ...rest } = context;
    const resumeWith = (root: EditorStep) => FlowExecutor.resume(flowOf(root), { ...rest, checkpointStore: store, runId: 'run-1' });

    // A step put in front would take the saved result of the step that is now second.
    await expect(resumeWith({ type: 'sequence', steps: [{ type: 'llmCall', prompt: 'audit', outputVariable: 'audit' }, ...steps] })).rejects.toMatchObject({
      code: 'LOUSHO_FLOW_CHANGED',
    });
    await expect(resumeWith({ type: 'sequence', steps: [steps[1], steps[0]] })).rejects.toMatchObject({ code: 'LOUSHO_FLOW_CHANGED' });
    expect(flakyCalls).toBe(1);

    failFlaky = false;
    const edited = await resumeWith({ type: 'sequence', steps: [{ type: 'llmCall', prompt: 'all about {{topic}}', outputVariable: 'first' }, steps[1]] });
    expect(edited.success).toBe(true);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('takes the same oneOf branch on resume, even if the variables changed since', async () => {
    const flow = flowOf({
      type: 'sequence',
      steps: [
        {
          type: 'oneOf',
          options: [
            {
              condition: '{{mode}} === "a"',
              step: {
                type: 'sequence',
                steps: [
                  { type: 'setVariable', variable: 'mode', value: 'b' },
                  { type: 'toolCall', tool: 'flaky', arguments: {} },
                  { type: 'return', value: 'branch a' },
                ],
              },
            },
            { step: { type: 'return', value: 'default branch' } },
          ],
        },
      ],
    });

    const failed = await FlowExecutor.execute(flow, { ...context, variables: { mode: 'a' } });
    expect(failed.success).toBe(false);
    failFlaky = false;

    const resumed = await FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'run-1' });
    expect(resumed.output).toBe('branch a');
    expect(resumed.variables.mode).toBe('b');
  });

  it('skips completed forEach iterations and parallel branches', async () => {
    const seen: unknown[] = [];
    let failOn: string | undefined = 'z';
    toolRegistry.register('record', {
      displayName: 'Record',
      tool: {
        description: 'Records its value',
        parameters: z.object({ value: z.string() }),
        execute: async ({ value }: { value: string }) => {
          if (value === failOn) throw new Error(`no ${value}`);
          seen.push(value);
          return value;
        },
      },
    });
    const flow = flowOf({
      type: 'parallel',
      steps: [
        { type: 'forEach', items: ['x', 'y', 'z'], step: { type: 'toolCall', tool: 'record', arguments: { value: '{{item}}' } } },
        { type: 'setVariable', variable: 'other', value: 'done' },
      ],
    });

    expect((await FlowExecutor.execute(flow, context)).success).toBe(false);
    expect(seen).toEqual(['x', 'y']);
    expect((await store.load('run-1'))?.flow?.completedNodeIds).toEqual(['0.1', '0.0.0', '0.0.1']);
    failOn = undefined;

    const resumed = await FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'run-1' });
    expect(resumed.success).toBe(true);
    expect(resumed.output).toEqual([['x', 'y', 'z'], 'done']);
    // Only the failed iteration ran again.
    expect(seen).toEqual(['x', 'y', 'z']);
    expect((await store.load('run-1'))?.flow?.completedNodeIds).toEqual(['0']);
  });

  it('rejects a resume without a checkpoint, of another flow, or without a store', async () => {
    const flow = flowOf({ type: 'sequence', steps: [{ type: 'return', value: 1 }, { type: 'toolCall', tool: 'flaky', arguments: {} }] });
    await expect(FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'nope' })).rejects.toMatchObject({
      code: 'LOUSHO_CHECKPOINT_NOT_FOUND',
    });

    await FlowExecutor.execute(flow, context);
    await expect(
      FlowExecutor.resume(flowOf(flow.flow as EditorStep, 'other'), { ...context, checkpointStore: store, runId: 'run-1' })
    ).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });

    await expect(FlowExecutor.execute(flow, { ...context, checkpointStore: undefined })).rejects.toMatchObject({
      code: 'LOUSHO_CONFIG_INVALID',
    });
  });
});
