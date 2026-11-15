/**
 * A run says when its tools failed (`result.toolErrors`,
 * `limits.maxToolErrors`), a rejected run says what it spent (`error.usage`),
 * a sub-agent's spend survives a crash of its lead (`delegatedInFlight`), and a
 * checkpointed run that rejects records why (`agent.pending()`'s `lastError`).
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { BudgetExceededError } from './budget';
import { PropagatingToolError } from './AgentExecutor';
import type { RunUsage } from '../models/usage';

const usage = { inputTokens: 10, outputTokens: 5 };
const call = (name: string): MockTurn => ({ toolCalls: [{ name }], usage });
const answer = (text: string): MockTurn => ({ text, usage });

const stats = defineTool({
  name: 'stats',
  description: 'stats',
  input: z.object({}),
  execute: async () => {
    throw new Error('stats backend down');
  },
});
const ok = defineTool({ name: 'ok', description: 'ok', input: z.object({}), execute: async () => 'fine' });

describe('result.toolErrors', () => {

  it("limits.maxToolErrors with onExceeded: 'throw' rejects with BudgetExceededError", async () => {
    const agent = createAgent({ provider: mockModel([call('stats'), answer('x')]), tools: [stats], limits: { maxToolErrors: 1, onExceeded: 'throw' } });

    const error = await agent.send('report').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).budget.limit).toBe('maxToolErrors');
  });
});

describe('error.usage', () => {

  it("keeps an error's own usage property", async () => {
    const own = Object.assign(new PropagatingToolError('own'), { usage: { mine: true } as unknown as RunUsage });
    const fatal = defineTool({
      name: 'fatal',
      description: 'fatal',
      input: z.object({}),
      execute: async () => {
        throw own;
      },
    });
    const error = (await createAgent({ provider: mockModel([call('fatal')]), tools: [fatal] }).send('go').catch((e: unknown) => e)) as PropagatingToolError;

    expect(error.usage).toEqual({ mine: true });
  });
});

describe('sub-agent usage across a crash of its lead', () => {
  it("checkpoints a running sub-agent's spend, and a resumed lead counts it", async () => {
    let release: () => void = () => undefined;
    let hang = true;
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        if (hang) await new Promise<void>((resolve) => (release = resolve));
        return 'slow done';
      },
    });
    const childScript = [call('ok'), call('slow'), answer('child done')];
    const child = createAgent({ provider: mockModel(childScript), tools: [ok, slow], instructions: 'Child.', description: 'Child' });
    const taskCall: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'child', description: 'a task', prompt: 'work' } }], usage };
    const store = memoryStore();
    const lead = createAgent({ provider: mockModel([taskCall, answer('lead done')]), store, subagents: { child } });

    const running = lead.send('go', { sessionId: 'orchestrator' });
    await vi.waitFor(async () => expect((await store.checkpoints!.load('orchestrator'))?.delegatedInFlight?.[0]?.modelCalls).toBe(2));

    // "Kill" the lead: copy its checkpoint as it stands into a fresh store and resume there.
    const crashed = await store.checkpoints!.load('orchestrator');
    const restarted = memoryStore();
    await restarted.checkpoints!.save('orchestrator', crashed!);
    hang = false;
    const child2 = createAgent({ provider: mockModel([answer('child redo')]), tools: [ok, slow], instructions: 'Child.', description: 'Child' });
    const lead2 = createAgent({ provider: mockModel([answer('lead done')]), store: restarted, subagents: { child: child2 } });

    const resumed = await lead2.resume('orchestrator');

    // Lead's task call (1) + the interrupted child's 2 calls + the re-run child (1) + the lead's answer (1).
    expect(resumed?.usage.modelCalls).toBe(5);
    expect(resumed?.usage.delegated?.runs).toBe(2);
    expect((await restarted.checkpoints!.load('orchestrator'))?.delegatedInFlight).toBeUndefined();

    release();
    const first = await running;
    expect(first.usage.modelCalls).toBe(5);
    expect((await store.checkpoints!.load('orchestrator'))?.delegatedInFlight).toBeUndefined();
  });
});
