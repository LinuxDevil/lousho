import { describe, it, expect } from 'vitest';
import { spansToObservations } from '../spansToObservations';

describe('spansToObservations', () => {

  it('treats a span whose parent is missing as a root of its own trace', () => {
    const [orphan] = spansToObservations([{ id: 'o', parentId: 'gone', name: 'o', startTime: 0, attributes: {} }]);
    expect(orphan.trace_id).toBe('o');
    expect(orphan.parent_obs_id).toBe('gone');
  });
});
