import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { memoryStore } from '../storage/agentStore';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';
import { classifyToolFailure, createProgressGuard, type ProgressGuardOptions } from './progressGuard';

const call = (name: string, args: Record<string, unknown> = {}, id?: string): MockTurn => ({ toolCalls: [{ name, args, ...(id && { id }) }] });
const repeat = (turn: (i: number) => MockTurn, times: number) => Array.from({ length: times }, (_, i) => turn(i));

function setup(turns: MockTurn[], execute: () => unknown, guard: ProgressGuardOptions = {}) {
  let runs = 0;
  const tool = defineTool({
    name: 'lookup',
    description: 'Look something up',
    input: z.object({ q: z.string().optional() }),
    execute: async () => {
      runs++;
      return execute();
    },
  });
  const agent = createAgent({ provider: mockModel(turns), tools: [tool], hooks: [createProgressGuard(guard)], store: memoryStore() });
  return { agent, runs: () => runs };
}

const toolResults = (messages: { role: string; content?: unknown }[]) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('createProgressGuard', () => {

  it('stops the run with a typed error after maxDenials denials', async () => {
    const { agent, runs } = setup(repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 10), () => 'same', { maxDenials: 1 });
    await expect(agent.send('go')).rejects.toMatchObject({ code: 'LOUSHO_RUN_NO_PROGRESS' });
    expect(runs()).toBe(3);
  });

  it('adds a hint from the second failure with the same signature, naming the fallback', async () => {
    const { agent } = setup([call('lookup', { q: 'a' }, 'c1'), call('lookup', { q: 'b' }, 'c2'), 'done'], () => {
      throw new Error('403 forbidden');
    }, { fallbacks: { lookup: 'search_docs' } });
    const [first, second] = toolResults((await agent.send('go')).messages);
    expect(first).not.toContain('search_docs');
    expect(second).toContain('search_docs');
    expect(second).toContain('permission');
  });

  it('streams each action as a heal.action event', async () => {
    const { agent } = setup([...repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 4), 'gave up'], () => 'same');
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('go')) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'heal.action', action: 'deny', toolName: 'lookup' }));
  });

  it('rejects limits that are not positive whole numbers', () => {
    for (const options of [{ maxRepeats: 0 }, { maxFailures: 1.5 }, { maxDenials: -1 }, { maxSameResults: 0 }]) {
      expect(() => createProgressGuard(options)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    }
  });
});

describe('classifyToolFailure', () => {
  it.each([
    ['execution', 'HTTP 403 Forbidden', 'permission'],
  ] as const)('%s + %s is %s', (kind, message, expected) => {
    expect(classifyToolFailure({ kind, message })).toBe(expected);
  });
});
