import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { atLeast, atMost, equals, includes, matches } from './checks';
import { defineEval } from './defineEval';
import { describeFailure, runTrajectoryCase, type EvalTestContext } from './trajectory';
import type { EvalResult } from './evalResult';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});
const checkPolicy = defineTool({
  name: 'check_policy',
  description: 'Check the refund policy',
  input: z.object({}),
  execute: () => ({ days: 30 }),
});
const issueRefund = defineTool({
  name: 'issue_refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  execute: () => ({ ok: true }),
});

const REFUND_SCRIPT: MockTurn[] = [
  { toolCalls: [{ name: 'lookup_order', args: { orderId: '42', verbose: true } }], usage: { inputTokens: 10, outputTokens: 5 } },
  { toolCalls: [{ name: 'check_policy' }], usage: { inputTokens: 10, outputTokens: 5 } },
  { text: 'You can return it within 30 days.', usage: { inputTokens: 10, outputTokens: 5 } },
];

function refundAgent(script: MockTurn[] = REFUND_SCRIPT, maxSteps?: number) {
  return createAgent({
    prompt: 'You handle refunds.',
    provider: mockModel(script),
    tools: [lookupOrder, checkPolicy, issueRefund],
    maxSteps,
  });
}

async function run(
  test: (t: EvalTestContext) => void | Promise<void>,
  options: { agent?: ReturnType<typeof refundAgent>; judge?: Parameters<typeof runTrajectoryCase>[0]['judge'] } = {}
): Promise<EvalResult> {
  const spec = { name: 'refund', agent: options.agent ?? refundAgent(), judge: options.judge, test };
  return runTrajectoryCase(spec, {}, undefined, undefined);
}

function failedMessages(result: EvalResult): string[] {
  return result.assertions.filter((a) => !a.passed).map((a) => a.message ?? '');
}

describe('trajectory assertions: diagnostic failures', () => {
  it('completed() explains a run that was cut off by maxSteps', async () => {
    const result = await run(
      async (t) => {
        await t.send('go');
        t.completed();
      },
      { agent: refundAgent(REFUND_SCRIPT, 1) }
    );
    expect(result.passed).toBe(false);
    expect(failedMessages(result)).toEqual([
      "completed() failed: finishReason was 'max-steps' (the run hit maxSteps while still calling tools)",
    ]);
  });

  it('calledTool() reports missing argument keys', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order', { args: { reason: 'damaged' } });
    });
    expect(failedMessages(result)[0]).toContain('reason: expected "damaged", got undefined');
  });

  it('calledTool() reports a wrong call count', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order', { times: 2 });
    });
    expect(failedMessages(result)).toEqual([
      "calledTool('lookup_order', {\"times\":2}) failed: 'lookup_order' was called 1 time(s), expected 2",
    ]);
  });

  it('notCalledTool() says how often the tool was called', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.notCalledTool('check_policy');
    });
    expect(failedMessages(result)).toEqual([
      "notCalledTool('check_policy') failed: 'check_policy' was called 1 time(s); tools called were [lookup_order, check_policy]",
    ]);
  });

  it('maxCostUsd() fails when the run reports no cost, since the budget cannot be checked', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.maxCostUsd(0.01);
    });
    expect(result.passed).toBe(false);
    expect(failedMessages(result)[0]).toMatch(/^maxCostUsd\(0\.01\) failed: the run reported no cost .*unknownCost: 'skip'/);
  });

  it("maxCostUsd(n, { unknownCost: 'skip' }) skips (counted as passed) with a warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await run(async (t) => {
        await t.send('go');
        t.maxCostUsd(0.01, { unknownCost: 'skip' });
      });
      expect(result.passed).toBe(true);
      expect(result.assertions[0]).toMatchObject({ name: 'maxCostUsd(0.01)', passed: true, skipped: true });
      expect(result.assertions[0].message).toContain('no cost');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxCostUsd(0.01) skipped'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('checks', () => {
  it('score and explain pass and fail', () => {
    expect(includes('a').evaluate('cat')).toMatchObject({ passed: true, score: 1 });
    expect(matches(/\d+/g).evaluate('order 42')).toMatchObject({ passed: true });
    expect(matches(/\d+/g).evaluate('order 42')).toMatchObject({ passed: true }); // global flag must not be stateful
    expect(matches(/\d+/).evaluate('none').message).toBe('expected "none" to match /\\d+/');
    expect(equals({ a: 1 }).evaluate({ a: 1 }).passed).toBe(true);
    expect(equals({ a: 1 }).evaluate({ a: 2 }).message).toBe('expected {"a":2} to equal {"a":1}');
    expect(atLeast(0.7).evaluate(0.8)).toEqual({ score: 0.8, passed: true, threshold: 0.7, message: undefined });
    expect(atLeast(0.7).evaluate(0.5).message).toBe('score 0.5 is below the threshold 0.7');
    expect(atMost(10).evaluate(11).message).toBe('value 11 is above the limit 10');
    expect(atMost(10).evaluate(10).passed).toBe(true);
  });
});

describe('errors', () => {
  it('records an error thrown by the test body instead of throwing', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      throw new Error('boom');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('boom');
    expect(describeFailure(result)).toContain('  - boom');
  });

  it('t.judge() without a judge provider throws a clear error and never calls an LLM', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      await t.judge('Is it polite?');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toContain('t.judge() needs a judge provider');
    expect(result.error).toContain('judge: { provider, model }');
    expect(result.error).toContain('*.judge.eval.ts');
  });
});

// --- real defineEval() registrations: datasets, labels, classic form unchanged -----------------

const seen: string[] = [];

defineEval({
  name: 'dataset eval',
  agent: () => createAgent({ provider: mockModel([(req) => `echo ${String(req.messages.at(-1)?.content)}`]) }),
  cases: [
    { input: 'alpha', expect: 'echo alpha' },
    { input: 'beta', label: 'the beta case', expect: 'echo beta' },
  ],
  async test(t, c) {
    seen.push(c.input);
    await t.send(c.input);
    t.completed();
    t.check('echoes', t.reply, equals(c.expect));
  },
});

defineEval({
  name: 'no cases',
  agent: createAgent({ provider: mockModel(['fine']) }),
  async test(t) {
    await t.send('x');
    t.check('reply', t.reply, includes('fine'));
  },
});
