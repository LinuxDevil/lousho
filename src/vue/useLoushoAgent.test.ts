// @vitest-environment node
/**
 * The Vue useLoushoAgent() run inside an effectScope (no DOM needed),
 * in process with mockModel and remote with a scripted fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, type EffectScope, type Ref } from 'vue';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createTodoTools } from '../tools/built-in/todo';
import { useTodos } from './useTodos';
import { useLoushoAgent, type LoushoAgentSource, type UseLoushoAgentOptions, type UseLoushoAgentResult } from './useLoushoAgent';

let scope: EffectScope | undefined;

function mount(source: LoushoAgentSource | Ref<LoushoAgentSource>, options?: UseLoushoAgentOptions): UseLoushoAgentResult {
  scope = effectScope();
  return scope.run(() => useLoushoAgent(source, options)) as UseLoushoAgentResult;
}

afterEach(() => {
  scope?.stop();
  scope = undefined;
});

function emailAgent(...turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { agent: createAgent({ provider: mockModel(turns), tools: [tool] }), execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam' }, id: 'call_email' }] };

describe('useLoushoAgent for Vue in process', () => {

  it('reject() marks the call rejected; answer() answers a question', async () => {
    const { agent, execute } = emailAgent(callEmail, 'OK, not sent.');
    const chat = mount({ agent });
    await chat.send('Email Sam');
    await chat.reject('not today');
    expect(execute).not.toHaveBeenCalled();
    expect(chat.messages.value[1]).toMatchObject({ text: 'OK, not sent.', toolCalls: [{ status: 'rejected' }] });

    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };
    const asking = mount({ agent: createAgent({ provider: mockModel([ask, 'Booking Lisbon.']), askQuestion: true }) });
    await asking.send('Book a trip');
    expect(asking.pendingApproval.value).toMatchObject({ kind: 'question', question: { text: 'Which city?' } });
    await asking.answer('Lisbon');
    expect(asking.messages.value[1]).toMatchObject({ text: 'Booking Lisbon.', toolCalls: [{ status: 'done' }] });
  });

  it('with sessionId turns share one session, and reset() starts over', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'You are Ali.', 'Who?']);
    const chat = mount({ agent: createAgent({ provider: model }), sessionId: 'chat-1' });
    await chat.send('My name is Ali.');
    await chat.send('What is my name?');
    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(true);

    chat.reset();
    expect(chat.messages.value).toEqual([]);
    expect(chat.status.value).toBe('idle');
    await chat.send('Hello again');
    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(false);
  });
});

describe('useTodos', () => {
  const todoWrite = { name: 'todo_write', args: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } };

  it('follows the todo list of an in-process run', async () => {
    const chat = mount({ agent: createAgent({ provider: mockModel([{ toolCalls: [todoWrite] }, 'done']), tools: createTodoTools().tools }) });
    const plan = useTodos(chat);
    expect(plan.todos.value).toEqual([]);

    await chat.send('Go');

    expect(plan.counts.value).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(plan.current.value?.content).toBe('Build');
    expect(plan.progress.value).toBeCloseTo(1 / 3);
    expect(chat.todos.value).toBe(plan.todos.value);
  });
});
