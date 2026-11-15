import { describe, expect, it } from 'vitest';

import type { ObserveRollupRow } from '../../../observe/types';
import { perAgentSeries } from '../monitoringSeries';

const T = Date.UTC(2026, 9, 25, 12);

const row = (agent_id: string, metric: string, value: number, bucket_start = T): ObserveRollupRow => ({
  bucket_start,
  granularity: 'hour',
  agent_id,
  metric,
  value,
});

describe('perAgentSeries', () => {

  it('keeps two agents in the same bucket as two series, never summed (error_rate, scaled)', () => {
    const rows = [row('a1', 'error_rate', 0.5), row('a2', 'error_rate', 0.25)];
    const { series } = perAgentSeries(rows, 'error_rate', (id) => id, (v) => v * 100);
    expect(series).toHaveLength(2);
    expect(Object.fromEntries(series.map((s) => [s.id, s.points]))).toEqual({
      a1: [{ t: T, v: 50 }],
      a2: [{ t: T, v: 25 }],
    });
  });
});
