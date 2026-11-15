/**
 * `agent.stream()` / `AgentExecutor.stream()` - the typed, versioned
 * event stream over the ordinary AgentExecutor loop.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AGENT_EVENT_SCHEMA_VERSION, AgentEvent, AgentEventOf, AgentEventType, isAgentEvent, isStepEvent, isTextEvent, isToolEvent } from './agentEvents';
import type { AgentRun } from './agentRun';
import { createAgent } from '../createAgent';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { LLMProvider, StreamChunk } from '../providers';

/** Reads every event, then checks the invariants every run must satisfy. */
async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  expectWellFormed(events, run.runId);
  return events;
}

function expectWellFormed(events: AgentEvent[], runId: string): void {
  events.forEach((event, index) => {
    expect(event.seq).toBe(index);
    expect(event.runId).toBe(runId);
    expect(event.v).toBe(AGENT_EVENT_SCHEMA_VERSION);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
    expect(isAgentEvent(event)).toBe(true);
  });
  expect(events[0].type).toBe('run.start');
  expect(events.filter((e) => e.type === 'run.done')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('run.done');
  const starts = events.filter((e) => e.type === 'step.start').map((e) => e.step);
  const dones = events.filter((e) => e.type === 'step.done').map((e) => e.step);
  expect(dones).toEqual(starts);
}

function only<T extends AgentEventType>(events: AgentEvent[], type: T): AgentEventOf<T>[] {
  return events.filter((e): e is AgentEventOf<T> => e.type === type);
}

function agentWith(provider: LLMProvider, tools: DefinedTool[] = []) {
  return createAgent({ instructions: 'Be brief.', provider, tools });
}

describe('agent.stream()', () => {

  it('starts parallel tool calls in call order and reports them done in completion order', async () => {
    let fastDone!: () => void;
    const fastFinished = new Promise<void>((resolve) => (fastDone = resolve));
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        await fastFinished;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'slow done';
      },
    });
    const fast = defineTool({
      name: 'fast',
      description: 'fast',
      input: z.object({}),
      execute: async () => {
        fastDone();
        return 'fast done';
      },
    });
    const model = mockModel([{ toolCalls: [{ name: 'slow' }, { name: 'fast' }] }, 'ok']);
    const events = await collect(agentWith(model, [slow, fast]).stream('go'));

    const toolEvents = events.filter(isToolEvent).map((e) => `${e.type}:${e.toolName}`);
    expect(toolEvents).toEqual(['tool.start:slow', 'tool.start:fast', 'tool.done:fast', 'tool.done:slow']);
  });

  it('fails the step on an error chunk from the provider stream', async () => {
    const model = mockModel(['never shown']);
    model.stream = async () => ({
      fullStream: (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'error', error: new Error('stream broke') };
      })(),
      textStream: (async function* () {})(),
      text: Promise.resolve(''),
      usage: Promise.reject(new Error('stream broke')),
      finishReason: Promise.reject(new Error('stream broke')),
      toolCalls: Promise.reject(new Error('stream broke')),
    });
    const run = agentWith(model).stream('hi', { throwOnError: false });
    const events = await collect(run);

    expect(only(events, 'error')[0].error.message).toContain('stream broke');
    await expect(run.result).rejects.toThrow(/stream broke/);
  });

  it('can be iterated only once', async () => {
    const run = agentWith(mockModel(['x'])).stream('hi');
    await collect(run);
    await expect(collect(run)).rejects.toThrow(/only be iterated once/);
  });

  it('family type guards narrow by prefix', async () => {
    const events = await collect(agentWith(mockModel(['a b'])).stream('hi'));
    expect(events.filter(isTextEvent).map((e) => e.type)).toEqual(['text.delta', 'text.delta', 'text.done']);
    expect(events.filter(isStepEvent).map((e) => e.step)).toEqual([1, 1]);
    expect(isAgentEvent({ type: 'text.delta', v: 2, seq: 0 })).toBe(false);
    expect(isAgentEvent('text.delta')).toBe(false);
  });
});
