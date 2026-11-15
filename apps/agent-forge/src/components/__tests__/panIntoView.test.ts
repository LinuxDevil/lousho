import { describe, expect, it } from 'vitest';
import { panIntoView } from '../CanvasArea';

// A 540x500 pane (the 1280px builder with the Inspector open); the margin kept from each edge is 24px.
describe('panIntoView', () => {

  it('pans left just enough to bring a node cut off on the right back in', () => {
    // The Output node at 700..860 once the Inspector narrows the pane: its right edge lands at 540 - 24.
    expect(panIntoView({ left: 700, top: 200, width: 160, height: 60 }, 540, 500)).toEqual({ dx: -344, dy: 0 });
  });
});
