import { describe, it, expect } from 'vitest';
import { upsertSpan } from '../spanReducer';
import type { SpanEvent } from '../../../shared/wireTypes';

function span(overrides: Partial<SpanEvent>): SpanEvent {
  return {
    id: 'span-1',
    name: 'agent.run',
    startTime: 0,
    attributes: {},
    ...overrides,
  };
}

describe('upsertSpan', () => {

  it('merges an onSpanEnd notification onto the same row an onSpanStart created, by id', () => {
    const started = [span({ id: 'a', startTime: 100 })];
    const ended = upsertSpan(started, span({ id: 'a', startTime: 100, endTime: 150 }));
    expect(ended).toHaveLength(1);
    expect(ended[0].endTime).toBe(150);
  });
});
