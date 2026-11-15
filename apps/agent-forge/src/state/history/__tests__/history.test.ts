import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { CanvasLayout } from '../../../../shared/wireTypes';
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  emptyHistory,
  record,
  redo,
  undo,
  type DocState,
} from '../history';

function doc(name: string, x = 0): DocState {
  return {
    spec: { version: 2, name, model: 'mock/mock-1', instructions: 'hi' } as AgentSpecV2,
    layout: { schemaVersion: 1, nodes: { agent: { x, y: 0 } }, notes: [] } satisfies CanvasLayout,
  };
}

const renamed = (d: DocState, name: string): DocState => ({ ...d, spec: { ...d.spec, name } });

describe('record/undo/redo', () => {

  it('returns undefined on empty stacks', () => {
    const h = emptyHistory();
    expect(undo(h, doc('a'))).toBeUndefined();
    expect(redo(h, doc('a'))).toBeUndefined();
  });

  it('caps the past at HISTORY_LIMIT, dropping the oldest', () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      h = record(h, doc(`a${i}`), doc(`b${i}`), 'Edit', i);
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    // The oldest kept entry is the 6th recorded change ('a5' -> 'b5').
    expect(h.past[0].forward.length).toBeGreaterThan(0);
    let state = doc('b104');
    // Undoing the whole kept window lands on the state after entry 5's "before",
    // i.e. doc('a5') — entries 0-4 were dropped.
    let cur = h;
    while (cur.past.length > 0) {
      const step = undo(cur, state)!;
      state = step.state;
      cur = step.history;
    }
    expect(state).toEqual(doc('a5'));
  });
});

describe('coalescing', () => {
  it('merges same-key edits inside COALESCE_MS into one entry', () => {
    const d0 = doc('a');
    const d1 = renamed(d0, 'b');
    const d2 = renamed(d1, 'c');
    let h = record(emptyHistory(), d0, d1, 'Edit', 1000, 'field:x:name');
    h = record(h, d1, d2, 'Edit', 1000 + COALESCE_MS, 'field:x:name');
    expect(h.past).toHaveLength(1);
    const back = undo(h, d2);
    expect(back?.state).toEqual(d0);
  });
});
