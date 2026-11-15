/**
 * `session.stream()` streams a session turn and persists it when the run is done.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { AgentEvent } from '../execution/agentEvents';
import type { AgentRun } from '../execution/agentRun';
import type { SessionStore } from './index';
import { MemorySessionStore } from './index';

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);

describe('AgentSession.stream()', () => {

  it('works without iterating, and an iterated run can only be read once', async () => {
    const session = createAgent({ provider: mockModel(['a', 'b']) }).session();

    const quiet = session.stream('one');
    expect((await quiet.result).text).toBe('a');
    expect(session.messages).toHaveLength(2);

    const run = session.stream('two');
    await collect(run);
    await expect(collect(run)).rejects.toThrow(/only be iterated once/);
    await expect(collect(run)).rejects.toMatchObject({ code: 'LOUSHO_RUN_ALREADY_ITERATED' });
  });

  it('keeps only the tool calls that ran when a stream is aborted by its signal', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        controller.abort();
        return 'done';
      },
    });
    const model = mockModel(['hello', { toolCalls: [{ name: 'slow' }, { name: 'slow' }] }, 'next']);
    const session = createAgent({ provider: model, tools: [slow] }).session();
    await session.send('hi');
    const before = session.messages;

    const run = session.stream('go', { signal: controller.signal });
    const events = await collect(run);

    expect((await run.result).finishReason).toBe('aborted');
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'aborted' });
    expect(session.messages.slice(0, before.length)).toEqual(before);
    expect(roles(session.messages.slice(before.length))).toEqual(['user', 'assistant', 'tool', 'tool']);
    await session.send('still there?');
    expect(roles(model.calls[2].messages.filter((m) => m.role !== 'system'))).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'tool', 'user']);
  });

  it('ends with error and run.done when the history cannot be loaded or the turn cannot be saved', async () => {
    const memory = new MemorySessionStore();
    const broken: SessionStore = {
      load: () => Promise.reject(new Error('load failed')),
      save: (id, messages) => memory.save(id, messages),
      delete: (id) => memory.delete(id),
    };
    const loadFails = createAgent({ provider: mockModel(['x']) }).session({ store: broken });
    const run = loadFails.stream('hi');
    const events = await collect(run);
    await expect(run.result).rejects.toThrow('load failed');
    expect(events.map((e) => [e.type, e.seq])).toEqual([
      ['error', 0],
      ['run.done', 1],
    ]);

    const saveFails = createAgent({ provider: mockModel(['x']) }).session({
      store: { ...memory, load: (id) => memory.load(id), save: () => Promise.reject(new Error('disk full')), delete: (id) => memory.delete(id) },
    });
    const saving = saveFails.stream('hi');
    const savingEvents = await collect(saving);
    await expect(saving.result).rejects.toThrow('disk full');
    expect(savingEvents.slice(-2).map((e) => e.type)).toEqual(['error', 'run.done']);
    expect(savingEvents.at(-1)).toMatchObject({ finishReason: 'error' });
    expect(savingEvents.map((e) => e.seq)).toEqual(savingEvents.map((_, i) => i));
  });
});
