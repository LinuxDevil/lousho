import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { scoreSeries, trajectoryGate, wilsonBounds, type ScorePoint } from './continuousScore';
import { ingestBatch, openDb } from './store';

const T0 = 1_790_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);

const series = (values: readonly number[]): ScorePoint[] => values.map((value, i) => ({ traceId: `t${i}`, at: T0 + i, value }));
const repeat = (value: number, times: number): number[] => Array.from({ length: times }, () => value);

function root(trace: string, at: number, attrs: Record<string, unknown> = {}, over: Record<string, unknown> = {}): IngestEvent {
  return {
    type: 'observation',
    data: {
      obs_id: `root-${trace}`,
      trace_id: trace,
      agent_id: 'support',
      kind: 'span',
      name: 'invoke_agent support',
      start: at,
      end: at + 10,
      status: 'ok',
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'stop', 'lousho.harness.revision': R1, ...attrs },
      ...over,
    },
  } as IngestEvent;
}

const score = (id: string, trace: string, value: number | undefined, source = 'online'): IngestEvent =>
  ({ type: 'score', data: { score_id: id, trace_id: trace, name: 'quality', ...(value !== undefined && { value }), source, agent_id: 'support', ts: T0 } }) as IngestEvent;

describe('trajectoryGate', () => {

  it('takes the window, floor, gain, drop and z as options', () => {
    expect(trajectoryGate(series([1, 1, 0.5]), { window: 1, drop: 0.4 }).state).toBe('regression');
    expect(trajectoryGate(series(repeat(0.7, 20)), { floor: 0.8 }).state).toBe('stall');
    expect(trajectoryGate(series([...repeat(0.5, 10), 0.51]), { gain: 0.001 }).sinceGain).toBe(0);
    expect(trajectoryGate(series([...repeat(0.9, 10), ...repeat(0.7, 10)]), { drop: 0.25 }).state).toBe('ok');
    const noisy = series([...repeat(1, 10), 1, 1, 1, 0, 1, 1, 0, 1, 1, 1]);
    expect(trajectoryGate(noisy, { z: 0.5 }).state).toBe('regression');
    expect(trajectoryGate(noisy).state).toBe('ok');
  });
});

describe('wilsonBounds', () => {

  it('takes another z, and says nothing for no runs', () => {
    expect(wilsonBounds(16, 20, 1.959963984540054).lower).toBeCloseTo(0.58398, 4);
    expect(wilsonBounds(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('scoreSeries', () => {
  it('is oldest first: online score means, else 0 for a failed run and 1 for a clean one', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      root('t1', T0),
      root('t2', T0 + 1, { 'lousho.run.finish_reason': 'max-steps' }),
      root('t3', T0 + 2),
      score('s1', 't3', 0.4),
      score('s2', 't3', 0.8),
      root('t4', T0 + 3, { 'lousho.harness.revision': R2 }),
    ]);

    expect(scoreSeries(db, { agent: 'support' })).toEqual([
      { traceId: 't1', at: T0, revision: R1, value: 1 },
      { traceId: 't2', at: T0 + 1, revision: R1, value: 0 },
      { traceId: 't3', at: T0 + 2, revision: R1, value: expect.closeTo(0.6, 10) as unknown as number },
      { traceId: 't4', at: T0 + 3, revision: R2, value: 1 },
    ]);
    expect(scoreSeries(db, { agent: 'support', revision: R2 }).map((point) => point.traceId)).toEqual(['t4']);
    expect(scoreSeries(db, { agent: 'support', limit: 2 }).map((point) => point.traceId)).toEqual(['t3', 't4']);
    expect(scoreSeries(db, { agent: 'support', since: T0 + 2 }).map((point) => point.traceId)).toEqual(['t3', 't4']);
    db.close();
  });
});
