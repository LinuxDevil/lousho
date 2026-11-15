/**
 * Steering - `run.steer()`, `InputQueue.steer()` and
 * `agent.session({ turnPolicy: 'steer' })`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import { textOf } from '../providers/content';
import type { Message } from '../providers';
import type { AgentEvent } from './agentEvents';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A model turn that signals `calling`, then holds its reply until `release()`. */
function slowTurn(text: string) {
  const calling = deferred();
  const released = deferred();
  const turn = async () => {
    calling.resolve();
    await released.promise;
    return text;
  };
  return { turn, calling: calling.promise, release: released.resolve };
}

/** A tool that signals `started`, then waits for `release`. */
function gatedTool() {
  const started = deferred();
  const release = deferred();
  const tool = defineTool({
    name: 'wait',
    description: 'waits',
    input: z.object({}),
    execute: async () => {
      started.resolve();
      await release.promise;
      return 'waited';
    },
  });
  return { tool, started: started.promise, release: release.resolve };
}

const conversation = (messages: readonly Message[] | MockRequest['messages'] | undefined) =>
  (messages ?? []).filter((m) => m.role !== 'system').map((m) => `${m.role}:${textOf(m as Message)}`);

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('run.steer()', () => {
  it('aborts a model call that has not emitted anything and calls the model once more with the input', async () => {
    const slow = slowTurn('Rome it is.');
    const model = mockModel([slow.turn, 'Paris it is.']);
    const run = createAgent({ provider: model }).stream('Plan a trip to Rome.');

    await slow.calling;
    const steered = run.steer('Actually, make it Paris.');
    const events = await collect(run);
    slow.release(); // the discarded call's reply arrives too late to matter

    expect(steered).toMatchObject({ id: expect.any(String), applied: 'immediate' });
    expect(await steered.joined).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(conversation(model.calls[1]?.messages)).toEqual(['user:Plan a trip to Rome.', 'user:Actually, make it Paris.']);
    const result = await run.result;
    expect(result.text).toBe('Paris it is.');
    expect(conversation(result.messages)).toEqual([
      'user:Plan a trip to Rome.',
      'user:Actually, make it Paris.',
      'assistant:Paris it is.',
    ]);

    const relevant = events.filter((e) => e.type.startsWith('step.') || e.type.startsWith('input.') || e.type.startsWith('text.'));
    expect(relevant.map((e) => e.type)).toEqual([
      'step.start',
      'input.steered',
      'step.done',
      'input.applied',
      'step.start',
      'text.delta',
      'text.delta',
      'text.delta',
      'text.done',
      'step.done',
    ]);
    expect(relevant[1]).toMatchObject({ id: steered.id, text: 'Actually, make it Paris.', mode: 'immediate' });
    expect(relevant[2]).toMatchObject({ step: 1, finishReason: 'steered' });
    expect(relevant[3]).toMatchObject({ id: steered.id, step: 2 });
    expect(events.filter((e) => e.type === 'text.delta').map((e) => e.type === 'text.delta' && e.text).join('')).toBe('Paris it is.');
  });

  it('lets a running tool call finish and keeps its result; calls not started yet are not run', async () => {
    const { tool, started, release } = gatedTool();
    const other = vi.fn(async () => 'never');
    const otherTool = defineTool({ name: 'other', description: 'other', input: z.object({}), execute: other });
    const model = mockModel([{ toolCalls: [{ name: 'wait' }, { name: 'other' }] }, 'Redirected.']);
    const run = createAgent({ provider: model, tools: [tool, otherTool], toolConcurrency: 1 }).stream('Start.');

    await started;
    const steered = run.steer('Stop that, do this.');
    release();
    const result = await run.result;

    expect(steered.applied).toBe('queued');
    expect(other).not.toHaveBeenCalled();
    expect(result.text).toBe('Redirected.');
    expect(conversation(model.calls[1]?.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'tool:{"error":"ToolNotRunError","toolName":"other","message":"Tool call was cancelled before it ran because the user steered the run to new input","kind":"not-run"}',
      'user:Stop that, do this.',
    ]);
  });
});

describe("agent.session({ turnPolicy: 'steer' })", () => {
  it('steers the running turn with a send() made while it runs', async () => {
    const slow = slowTurn('Rome.');
    const model = mockModel([slow.turn, 'Paris.']);
    const session = createAgent({ provider: model }).session({ turnPolicy: 'steer' });

    const first = session.send('Rome?');
    await slow.calling;
    const second = session.send('Paris?');

    const [a, b] = await Promise.all([first, second]);
    slow.release();
    expect(b).toBe(a);
    expect(model.calls).toHaveLength(2);
    expect(conversation(session.messages)).toEqual(['user:Rome?', 'user:Paris?', 'assistant:Paris.']);
  });
});
