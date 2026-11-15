import { describe, expect, it } from 'vitest';

import type { ObserveRollupRow } from '../../../observe/types';
import { metricSummary, splitWindow, windowTotals } from '../monitoringMetrics';
import { chartWindow, insightsSpan, WINDOWS, type MonitoringWindow } from '../monitoringSeries';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 25, 12);

const row = (agent_id: string, metric: string, value: number, bucket_start = T): ObserveRollupRow => ({
  bucket_start,
  granularity: 'hour',
  agent_id,
  metric,
  value,
});

describe('splitWindow', () => {
  // A 3-bucket window [T, T + 3h): two complete buckets, then the one still in progress.

  it('no comparison while the window has no complete bucket', () => {
    const split = splitWindow([row('a', 'runs', 1, T - HOUR), row('a', 'runs', 2, T)], { from: T, to: T + HOUR, bucketMs: HOUR });
    expect(split.window.map((r) => r.value)).toEqual([2]);
    expect(split.compare).toBeNull();
  });
});

describe('steady traffic, `now` pinned mid-bucket', () => {
  // 120 runs and $0.60 an hour, every hour; the bucket holding `now` has only its elapsed share.
  const PER_HOUR = 120;
  const steady = (win: MonitoringWindow, now: number) => {
    const w = chartWindow(win, now);
    const { since, until } = insightsSpan(w);
    const rows: ObserveRollupRow[] = [];
    for (let b = since; b < until; b += w.bucketMs) {
      const hours = (Math.min(b + w.bucketMs, now) - b) / HOUR;
      if (hours <= 0) continue;
      rows.push(row('a', 'runs', PER_HOUR * hours, b), row('a', 'cost_usd', 0.6 * hours, b));
    }
    return { w, rows };
  };

  for (const win of WINDOWS) {
    it(`${win}: runs and cost deltas are 0%`, () => {
      const now = Date.UTC(2026, 9, 25, 10, 5);
      const { w, rows } = steady(win, now);
      const split = splitWindow(rows, w);
      const m = metricSummary(split.window, split.compare);
      expect(m.runs.delta).toBeCloseTo(0, 9);
      expect(m.cost.delta).toBeCloseTo(0, 9);
      // The value still counts the bucket in progress.
      const visible = rows.filter((r) => r.metric === 'runs' && r.bucket_start >= w.from).reduce((a, r) => a + r.value, 0);
      expect(m.runs.value).toBeCloseTo(visible);
    });
  }
});

describe('windowTotals', () => {

  it('p95 falls back to the plain mean when no p95 row has runs beside it', () => {
    const rows = [row('a', 'p95_latency_ms', 1000), row('b', 'p95_latency_ms', 2000)];
    expect(windowTotals(rows).p95).toBe(1500);
  });
});
