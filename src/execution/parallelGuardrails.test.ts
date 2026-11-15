/**
 * `runInParallel` input guardrails check the new input while the first
 * model call is already in flight. The call's output is held until every
 * parallel check passes; a trip cancels the call and nothing it produced is
 * shown, run, checkpointed or kept.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { PropagatingToolError } from './AgentExecutor';
import { moderationGuardrail, promptInjectionGuardrail } from './guardrailStarterSet';
import { PARALLEL_REWRITE_PREFIX, regexGuardrail, type IoGuardrail, type IoGuardrailContext, type IoGuardrailResult } from './ioGuardrails';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `runInParallel` guardrail whose check resolves when the test says so. */
function gatedGuardrail(name = 'gated') {
  const verdict = deferred<IoGuardrailResult>();
  const seen: IoGuardrailContext[] = [];
  const guardrail: IoGuardrail = {
    name,
    runInParallel: true,
    check: (ctx) => {
      seen.push(ctx);
      return verdict.promise;
    },
  };
  return { guardrail, seen, pass: () => verdict.resolve({ ok: true }), block: (reason = 'blocked') => verdict.resolve({ ok: false, reason }), verdict };
}

/** A model turn that waits for `until` (or the call's abort) before answering `turn`. */
function waitingTurn(until: Promise<unknown>, turn: Exclude<MockTurn, (...args: never[]) => unknown>): MockTurn {
  return async (request) => {
    await Promise.race([
      until,
      new Promise((resolve) => (request.signal as AbortSignal | undefined)?.addEventListener('abort', resolve, { once: true })),
    ]);
    return turn;
  };
}

/** Collects a run's events as they arrive, so a test can look at them mid-run. */
function record(run: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of run) events.push(event);
  })();
  return { events, done };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  expect(predicate()).toBe(true);
}

function weatherTool() {
  const runs: string[] = [];
  const tool = defineTool({
    name: 'get_weather',
    description: 'Weather for a city',
    input: z.object({ city: z.string() }),
    execute: ({ city }) => {
      runs.push(city);
      return { tempC: 21 };
    },
  });
  return { tool, runs };
}

function memoryStore() {
  const saved: Checkpoint[] = [];
  const store: CheckpointStore = {
    async save(_sessionId, checkpoint) {
      saved.push(JSON.parse(JSON.stringify(checkpoint)) as Checkpoint);
    },
    async load() {
      return saved.at(-1) ?? null;
    },
    async delete() {},
  };
  return { store, saved };
}

describe('runInParallel input guardrails: a trip', () => {

  it('discards a reply that came first: no tool runs, no checkpoint holds it; its reported usage counts', async () => {
    const gate = gatedGuardrail();
    const { tool, runs } = weatherTool();
    const { store, saved } = memoryStore();
    const model = mockModel([{ text: 'calling', toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }], usage: { inputTokens: 12, outputTokens: 3 } }]);
    const agent = createAgent({ provider: model, tools: [tool], store: { checkpoints: store }, guardrails: { input: [gate.guardrail] } });

    const stream = agent.stream('bad', { sessionId: 's1' });
    const run = record(stream);
    const events = run.events;
    await until(() => model.calls.length === 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(saved).toEqual([]);
    gate.block();
    await run.done;
    const done = await stream.result;

    expect(done.finishReason).toBe('guardrail');
    expect(runs).toEqual([]);
    expect(done.toolCalls).toEqual([]);
    expect(done.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, modelCalls: 1, estimated: false });
    expect(saved.every((checkpoint) => checkpoint.messages.every((m) => m.role === 'user' || m.role === 'system'))).toBe(true);
    expect(saved.at(-1)?.status).toBe('finished');
    expect(events.map((e) => e.type)).not.toContain('text.delta');
    expect(events.find((e) => e.type === 'step.done')).toMatchObject({ usage: { inputTokens: 12, estimated: false } });
  });

  it('a rewrite from a parallel guardrail blocks, with the reason prefixed', async () => {
    const model = mockModel(['x'], { onExhausted: 'repeat-last' });
    const redact = { ...regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/, action: 'rewrite' }), runInParallel: true };
    const agent = createAgent({ provider: model, guardrails: { input: [redact] } });

    const result = await agent.send('my ssn is 123-45-6789');

    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail?.reason.startsWith(PARALLEL_REWRITE_PREFIX)).toBe(true);
    expect(result.text).toBe('');
    expect(result.messages.at(-1)?.content).toBe('my ssn is 123-45-6789'); // never rewritten
  });

  it('a throwing check fails the run and cancels the call', async () => {
    const model = mockModel([waitingTurn(new Promise(() => undefined), 'x')]);
    const failing: IoGuardrail = { name: 'broken', runInParallel: true, check: () => Promise.reject(new Error('classifier down')) };
    const agent = createAgent({ provider: model, guardrails: { input: [failing] } });

    await expect(agent.send('hi')).rejects.toThrow('classifier down');
    expect((model.calls[0].signal as AbortSignal).aborted).toBe(true);
  });
});

describe('runInParallel input guardrails: resume and sub-agents', () => {
  it('a run resumed after an approval does not check the input again', async () => {
    let checks = 0;
    const counting: IoGuardrail = { name: 'counting', runInParallel: true, check: () => (checks++, { ok: true }) };
    const deploy = defineTool({ name: 'deploy', description: 'Deploy', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const model = mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [deploy], guardrails: { input: [counting] } });

    const paused = await agent.send('deploy');
    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('done');
    expect(checks).toBe(1);
  });

  it('a resumed run with new input queued behind pending tool calls runs no tool before the parallel checks pass', async () => {
    let runs = 0;
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploy',
      input: z.object({}),
      execute: () => {
        runs++;
        if (runs === 1) throw new PropagatingToolError('process died');
        return 'deployed';
      },
    });
    const { store, saved } = memoryStore();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, 'never']);
    const crashing = createAgent({ provider: model, tools: [deploy], store: { checkpoints: store } });
    await expect(crashing.send('deploy', { sessionId: 's1' })).rejects.toThrow('process died');
    expect(saved.at(-1)?.status).toBe('in-progress');

    const gate = gatedGuardrail();
    const agent = createAgent({ provider: model, tools: [deploy], store: { checkpoints: store }, guardrails: { input: [gate.guardrail] } });
    const result = agent.send('and also delete prod', { sessionId: 's1' });
    await until(() => gate.seen.length === 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(runs).toBe(1); // the pending call waits for the verdict

    gate.block();
    const done = await result;
    expect(done.finishReason).toBe('guardrail');
    expect(gate.seen[0].text).toBe('and also delete prod');
    expect(runs).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it('a trip inside a sub-agent cancels its call and nothing of it streams', async () => {
    const childText = 'child secret';
    const trips: IoGuardrail = {
      name: 'no-forbidden',
      runInParallel: true,
      check: async ({ text }) => {
        await tick();
        return text.includes('forbidden') ? { ok: false, reason: 'forbidden' } : { ok: true };
      },
    };
    const childModel = mockModel([waitingTurn(new Promise(() => undefined), childText)]);
    const child = createAgent({ provider: childModel, description: 'Helper' });
    const leadModel = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'forbidden task', description: 'help' } }] },
      'lead done',
    ]);
    const lead = createAgent({ provider: leadModel, subagents: { child }, guardrails: { input: [trips] } });

    const stream = lead.stream('go');
    const run = record(stream);
    await run.done;

    expect((childModel.calls[0].signal as AbortSignal).aborted).toBe(true);
    const childDeltas = run.events.filter((e) => e.type === 'text.delta' && e.subagent);
    expect(childDeltas).toEqual([]);
    expect(run.events.find((e) => e.type === 'guardrail.tripped')).toMatchObject({ name: 'no-forbidden', subagent: { name: 'child' } });
    expect(JSON.stringify(leadModel.calls[1].messages)).not.toContain(childText);
    expect((await stream.result).text).toBe('lead done');
  });
});

describe('runInParallel on the starter set', () => {
  it('promptInjectionGuardrail and moderationGuardrail take runInParallel (default off)', () => {
    const model = mockModel(['NONE']);
    expect(moderationGuardrail({ model }).runInParallel).toBeUndefined();
    expect(moderationGuardrail({ model, runInParallel: true }).runInParallel).toBe(true);
    expect(promptInjectionGuardrail({ model }).runInParallel).toBeUndefined();
    expect(promptInjectionGuardrail({ model, runInParallel: true }).runInParallel).toBe(true);
  });
});
