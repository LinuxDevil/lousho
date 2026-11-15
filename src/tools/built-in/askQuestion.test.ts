/**
 * The built-in `ask_question` tool pauses the run through the
 * approval mechanism until a human answers (or declines), durably.
 */
import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { memoryStore, type AgentStore } from '../../storage/agentStore';
import { SqliteStore } from '../../storage/sqlite';
import { mockModel, type MockTurn } from '../../testing';
import type { Message } from '../../providers';
import type { ToolExecutionContext } from '../../types';
import { askQuestionTool } from './askQuestion';

const asking = (args: Record<string, unknown>): MockTurn => ({ toolCalls: [{ name: 'ask_question', args, id: 'call_q' }] });
const whichCity = asking({ question: 'Which city?', options: ['Porto', 'Lisbon'] });

/** The `ask_question` result the model saw on its last call. */
function seen(model: ReturnType<typeof mockModel>): { content: unknown; isError?: boolean } {
  const message = (model.lastCall?.messages as Message[]).find((m) => m.role === 'tool' && m.toolCallId === 'call_q');
  return { content: JSON.parse(message?.content as string), isError: message?.isError };
}

describe('ask_question', () => {

  it('with allowFreeText: false, an answer outside the options reaches the model as a tool error', async () => {
    const model = mockModel([asking({ question: 'Which city?', options: ['Porto'], allowFreeText: false }), 'Hm.']);
    const agent = createAgent({ provider: model, askQuestion: true });

    const paused = await agent.send('Book a trip');
    await agent.approvals.answer({ id: paused.approvalId!, answer: 'Faro' });

    expect(seen(model)).toMatchObject({ content: { kind: 'execution', message: 'The answer must be one of: Porto' }, isError: true });
  });

  it('is only registered with askQuestion: true; run without an answer it fails', async () => {
    const model = mockModel(['Hi.']);
    await createAgent({ provider: model }).send('Hi');
    expect(model.lastCall?.tools?.map((tool) => tool.function.name) ?? []).not.toContain('ask_question');

    const ctx = { toolCallId: 'c1', messages: [] } as unknown as ToolExecutionContext;
    await expect(askQuestionTool().execute({ question: 'Where?' }, ctx)).rejects.toThrow(/No answer/);
  });
});

const stores: Array<[string, () => AgentStore & { close?: () => void }]> = [
  ['memoryStore()', memoryStore],
  ["SqliteStore(':memory:')", () => new SqliteStore(':memory:')],
];

describe.each(stores)('ask_question with createAgent({ store: %s })', (_name, makeStore) => {
  it('a restart between the question and the answer: a fresh agent answers and finishes the run', async () => {
    const store = makeStore();
    const before = createAgent({ provider: mockModel([whichCity]), askQuestion: true, store });
    const paused = await before.send('Book a trip', { sessionId: 'trip-1' });
    expect(paused.finishReason).toBe('awaiting-approval');

    const model = mockModel(['Booked Lisbon.']);
    const agent = createAgent({ provider: model, askQuestion: true, store });
    await expect(agent.resume('trip-1')).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError' });
    const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'Lisbon' });

    expect(result.text).toBe('Booked Lisbon.');
    expect(seen(model).content).toEqual({ answer: 'Lisbon', option: 1 });
    expect(await store.checkpoints!.load('trip-1')).toMatchObject({ status: 'finished' });
    store.close?.();
  });
});
