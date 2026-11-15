import { describe, expect, it } from 'vitest';
import { anchorStyle } from '../anchor';

const rect = { left: 100, right: 140, top: 50, bottom: 82, width: 40, height: 32 } as DOMRect;
const viewport = { width: 1000, height: 800 };
const popup = { width: 180, height: 120 };

describe('anchorStyle', () => {

  it('flips above when the popup would leave the viewport and there is room', () => {
    const low = { ...rect, top: 700, bottom: 732 } as DOMRect;
    // top = 732 + 4 = 736; 736 + 120 > 800 - 8 and 700 - 4 - 120 = 576 >= 8 -> flip.
    expect(anchorStyle(low, popup, { side: 'bottom', align: 'start', offset: 4, viewport })).toEqual({
      top: 576,
      left: 100,
      side: 'top',
    });
  });
});
