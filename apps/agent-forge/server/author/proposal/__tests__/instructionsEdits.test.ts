import { describe, expect, it } from 'vitest';
import { applyInstructionsEdits } from '../instructionsEdits';

/**
 * applyInstructionsEdits (AA09): every `oldText` must occur exactly once,
 * no two anchors may overlap, and the edits apply right-to-left so each
 * splice sees the positions the others were anchored at.
 */

const TEXT = 'alpha beta gamma delta';

describe('applyInstructionsEdits', () => {

  it('overlapping anchors are ANCHOR_OVERLAP naming both edits', () => {
    const result = applyInstructionsEdits(TEXT, [
      { oldText: 'beta gamma', newText: 'x' },
      { oldText: 'gamma delta', newText: 'y' },
    ]);
    expect(result).toEqual({ ok: false, code: 'ANCHOR_OVERLAP', index: 0, otherIndex: 1 });
  });
});
