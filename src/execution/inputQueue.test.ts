/**
 * Queued follow-up input - `run.enqueue()`, `ExecuteOptions.inputQueue`
 * and `agent.session({ turnPolicy: 'queue' })`.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockRequest } from '../testing';
import { textOf } from '../providers/content';
import type { Message } from '../providers';
import { AgentExecutor, PropagatingToolError } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { InputQueue } from './inputQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A tool that signals `started`, then waits for `release` (with `crashOnce`, its first run then dies). */
function gatedTool(options: { crashOnce?: boolean } = {}) {
  const started = deferred();
  const release = deferred();
  let runs = 0;
  const tool = defineTool({
    name: 'wait',
    description: 'waits',
    input: z.object({}),
    execute: async () => {
      started.resolve();
      await release.promise;
      if (options.crashOnce && ++runs === 1) throw new PropagatingToolError('process died');
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

describe('run.enqueue()', () => {

  it('takes another step for input queued while the model gives its final reply', async () => {
    const replying = deferred();
    const release = deferred();
    const model = mockModel([
      async () => {
        replying.resolve();
        await release.promise;
        return 'First answer.';
      },
      'Second answer.',
    ]);
    const run = createAgent({ provider: model }).stream('Q1');

    await replying.promise;
    run.enqueue('Q2');
    release.resolve();
    const result = await run.result;

    expect(result.text).toBe('Second answer.');
    expect(conversation(result.messages)).toEqual(['user:Q1', 'assistant:First answer.', 'user:Q2', 'assistant:Second answer.']);
  });
});

describe('ExecuteOptions.inputQueue', () => {
  it('lets a send()-style caller push input into a running execute()', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'ok']);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany([tool]);
    const inputQueue = new InputQueue();

    const pending = AgentExecutor.execute({
      agent: { id: 'a', name: 'A', prompt: 'p', tools: { wait: { tool: 'wait' } } },
      provider: model,
      toolRegistry,
      input: 'Start.',
      inputQueue,
    });
    await started;
    const queued = inputQueue.push('More.');
    release();
    await pending;

    expect(await queued.applied).toBe(true);
    expect(conversation(model.calls[1]?.messages).at(-1)).toBe('user:More.');
    expect(inputQueue.push('after').applied).toBe(false);
  });
});

describe("agent.session({ turnPolicy: 'queue' })", () => {

  it('runs the input as its own turn when the running turn is aborted before taking it', async () => {
    const controller = new AbortController();
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Own turn.']);
    const session = createAgent({ provider: model, tools: [tool] }).session({ turnPolicy: 'queue' });

    const first = session.send('Start.', { signal: controller.signal });
    await started;
    const second = session.send('And this.');
    controller.abort();
    release();

    expect((await first).finishReason).toBe('aborted');
    expect((await second).text).toBe('Own turn.');
    // The aborted turn keeps the tool call that ran (and its result); the rest of it is dropped.
    expect(conversation(session.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'user:And this.',
      'assistant:Own turn.',
    ]);
  });

  it('joins a running turn from stream() too', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Both handled.']);
    const session = createAgent({ provider: model, tools: [tool] }).session({ turnPolicy: 'queue' });

    const first = session.stream('Start.');
    await started;
    const joined = session.stream('And this.');
    release();

    const events = await collect(joined);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'Both handled.' });
    expect(await joined.result).toBe(await first.result);
    expect(conversation(session.messages).at(-2)).toBe('user:And this.');
  });
});
