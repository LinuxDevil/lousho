import { describe, expect, it } from 'vitest';
import { traceTotals } from '../TraceHeader';
import type { ObserveObservationRow } from '../../../observe/types';

const row = (over: Partial<ObserveObservationRow>): ObserveObservationRow =>
  ({ parent_obs_id: null, kind: 'span', usage_input_tokens: null, usage_output_tokens: null, cost_usd: null, ...over }) as ObserveObservationRow;

describe('traceTotals', () => {
  it("counts a run's tokens once when the root rolls up its model calls", () => {
    const rows = [
      row({ obs_id: 'root', usage_input_tokens: 624, usage_output_tokens: 3021, cost_usd: 0 }),
      row({ obs_id: 'chat', parent_obs_id: 'root', kind: 'generation', usage_input_tokens: 624, usage_output_tokens: 3021, cost_usd: 0 }),
    ];
    expect(traceTotals(rows)).toEqual({ tokens: 3645, cost: 0 });
  });

  it('sums generations when the root carries no usage', () => {
    const rows = [
      row({ obs_id: 'root' }),
      row({ obs_id: 'a', parent_obs_id: 'root', kind: 'generation', usage_input_tokens: 10, usage_output_tokens: 5 }),
      row({ obs_id: 'b', parent_obs_id: 'root', kind: 'generation', usage_input_tokens: 20, usage_output_tokens: 5 }),
    ];
    expect(traceTotals(rows).tokens).toBe(40);
  });
});
