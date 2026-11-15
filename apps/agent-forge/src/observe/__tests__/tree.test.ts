import { describe, it, expect } from 'vitest';
import { flattenObservationTree, nestObservations } from '../tree';
import type { ObserveObservationRow } from '../types';

let seq = 0;
function row(patch: Partial<ObserveObservationRow>): ObserveObservationRow {
  seq += 1;
  return {
    obs_id: `obs-${seq}`,
    trace_id: 'trace-1',
    session_id: null,
    agent_id: 'agent-1',
    parent_obs_id: null,
    kind: 'span',
    name: null,
    start: 0,
    end: null,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...patch,
  };
}

describe('nestObservations', () => {

  it('treats a self-parent as a root and survives parent/child cycles', () => {
    const selfish = row({ obs_id: 'self', parent_obs_id: 'self', start: 0 });
    const a = row({ obs_id: 'a', parent_obs_id: 'b', start: 10 });
    const b = row({ obs_id: 'b', parent_obs_id: 'a', start: 20 });
    const tree = nestObservations([selfish, a, b]);
    // Both rows are reachable somewhere at root level - nothing is dropped.
    const flat = flattenObservationTree(tree);
    expect(flat.map((n) => n.row.obs_id).sort()).toEqual(['a', 'b', 'self']);
  });
});
