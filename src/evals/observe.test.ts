/**
 * Eval score emission (observability evaluators): `scoreEventsOf` maps one
 * score row per AssertionResult (`<eval>/<assertion>`, judge vs eval source,
 * failure comment); `evalCaseObservation` runs the case inside an `eval`
 * span when LOUSHO_OBSERVE is set - the span's id is the trace_id the score
 * rows and the exercised run share - and stays a plain no-op when it is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { IngestEvent } from '../observe/envelope';
import type { EvalResult } from './evalResult';
import { evalCaseObservation, scoreEventsOf, scoredAgentName } from './observe';
import { runTrajectoryCase } from './trajectory';
import { atLeast } from './checks';
import { remoteTarget } from './remoteTarget';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';

const noopFetch = () => {
  const calls: { url: string; batch: IngestEvent[] }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), batch: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
    return new Response('{}', { status: 202 });
  });
  return { fetchFn, calls };
};

const scoreEvents = (calls: { batch: IngestEvent[] }[]) =>
  calls.flatMap((c) => c.batch).filter((e): e is Extract<IngestEvent, { type: 'score' }> => e.type === 'score');

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    name: 'refund eval',
    tags: [],
    passed: true,
    assertions: [
      { name: 'completed()', kind: 'gate', passed: true, score: 1, threshold: 1 },
      { name: 'tone', kind: 'soft', passed: false, score: 0.2, threshold: 0.7, message: 'soft check failed', source: 'judge' },
    ],
    durationMs: 5,
    steps: 1,
    toolCalls: [],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scoreEventsOf', () => {

  it('emits an eval-level pass/fail row after the per-assertion rows', () => {
    const base = { kind: 'gate' as const, score: 1 };
    const events = scoreEventsOf(
      result({
        assertions: [
          { ...base, name: 'completed()', passed: true },
          { ...base, name: 'mentions receipt (expected to fail)', passed: false, score: 0 },
          { ...base, name: 'no tools', passed: true },
        ],
      }),
      { traceId: 'trace-1', agentId: 'agent-1', now: () => 42, newId: () => 'fresh-id' }
    );
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual({
      type: 'score',
      data: {
        score_id: 'fresh-id',
        trace_id: 'trace-1',
        name: 'refund eval',
        value: 0,
        source: 'eval',
        comment: 'mentions receipt (expected to fail)',
        agent_id: 'agent-1',
        ts: 42,
      },
    });
  });

  it('eval-level row is 1 with no comment when every assertion passed, and absent with zero assertions', () => {
    const passing = scoreEventsOf(result({ assertions: [{ name: 'a', kind: 'gate', passed: true, score: 1 }] }), { traceId: 't' });
    const last = passing[passing.length - 1] as Extract<IngestEvent, { type: 'score' }>;
    expect(last.data).toMatchObject({ name: 'refund eval', value: 1 });
    expect(last.data.comment).toBeUndefined();
    expect(scoreEventsOf(result({ assertions: [] }), { traceId: 't' })).toEqual([]);
  });
});

describe('scoredAgentName', () => {

  it('is undefined for remote targets and nothing', () => {
    expect(scoredAgentName(remoteTarget({ url: 'http://x.test' })())).toBeUndefined();
    expect(scoredAgentName(undefined)).toBeUndefined();
  });
});

describe('evalCaseObservation', () => {

  it('adds at most ~2.5s per case when the daemon accepts but never answers, then skips the waits', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const observation = () => evalCaseObservation({ evalName: 'e', agent: { name: 'eval-blackhole' }, env: { LOUSHO_OBSERVE: 'http://x' } });
    const first = observation();
    const started = Date.now();
    await expect(first.run(async () => 'ok')).resolves.toBe('ok');
    await first.emit(result());
    expect(Date.now() - started).toBeLessThan(2500);
    const second = observation();
    const again = Date.now();
    await second.run(async () => 'ok');
    await second.emit(result());
    expect(Date.now() - again).toBeLessThan(200);
  });
});

describe('runTrajectoryCase emission (integration)', () => {
  const lookup = defineTool({
    name: 'lookup_order',
    description: 'Look up an order',
    input: z.object({ orderId: z.string() }),
    execute: ({ orderId }) => ({ orderId }),
  });

  it('emits score rows bound to the exercised run trace, judge verdicts as source judge', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubEnv('LOUSHO_OBSERVE', '1');
    vi.stubEnv('LOUSHO_OBSERVE_PORT', '1');
    vi.stubGlobal('fetch', fetchFn);
    const agent = createAgent({ name: 'eval-scored-agent', prompt: 'p', provider: mockModel(['done.']), tools: [lookup] });
    const judge = { provider: mockModel(['SCORE: 0.9']) };
    const res = await runTrajectoryCase(
      {
        name: 'scored eval',
        agent,
        judge,
        test: async (t) => {
          await t.send('hi');
          t.completed();
          t.soft('tone', await t.judge('be nice'), atLeast(0.7));
        },
      },
      {},
      'case a',
      undefined
    );
    expect(res.passed).toBe(true);
    expect(res.assertions.find((a) => a.name === 'tone')?.source).toBe('judge');
    await vi.waitFor(() => expect(scoreEvents(calls)).toHaveLength(3));
    const scores = scoreEvents(calls);
    const traceIds = new Set(scores.map((e) => e.data.trace_id));
    expect(traceIds.size).toBe(1);
    expect(scores.map((e) => e.data.name).sort()).toEqual(['scored eval', 'scored eval/completed()', 'scored eval/tone']);
    expect(scores.find((e) => e.data.name === 'scored eval/tone')?.data.source).toBe('judge');
    expect(scores.find((e) => e.data.name === 'scored eval/completed()')?.data.source).toBe('eval');
    expect(scores.every((e) => typeof e.data.agent_id === 'string' && e.data.agent_id.length > 0)).toBe(true);
  });
});
