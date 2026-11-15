import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { computeChangedFields } from '../../../shared/specFields';
import type { SpecSnapshot } from '../../../shared/wireTypes';

function snapshot(spec: Record<string, unknown>, labels: string[] = []): SpecSnapshot {
  return {
    spec: { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run.', ...spec } as AgentSpecV2,
    labels,
  };
}

describe('computeChangedFields', () => {

  it('treats empty values as absent: [], "", {}, null and undefined are all equivalent', () => {
    const before = snapshot({ tools: [], description: '', modelSettings: {}, fallbackModels: undefined }, []);
    const after = snapshot({}, []);
    expect(computeChangedFields(before, after)).toEqual([]);
    // ...and adding an empty value is no change either.
    expect(computeChangedFields(after, before)).toEqual([]);
  });
});
