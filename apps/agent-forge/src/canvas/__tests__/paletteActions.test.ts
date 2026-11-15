import { describe, it, expect } from 'vitest';
import { freeSpot } from '../paletteActions';
import { nextTabId } from '../../components/tabs';

describe('tab keyboard model', () => {
  const ids = ['test', 'logs', 'trace'] as const;

  it('moves with the arrow keys, wrapping, and jumps with Home/End', () => {
    expect(nextTabId(ids, 'test', 'ArrowRight')).toBe('logs');
    expect(nextTabId(ids, 'trace', 'ArrowRight')).toBe('test');
    expect(nextTabId(ids, 'test', 'ArrowLeft')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'Home')).toBe('test');
    expect(nextTabId(ids, 'logs', 'End')).toBe('trace');
    expect(nextTabId(ids, 'logs', 'a')).toBeUndefined();
  });
});

describe('freeSpot', () => {
  it('keeps a free position and stacks below nodes already at the drop point', () => {
    expect(freeSpot([{ x: 500, y: 500 }], { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    expect(freeSpot([{ x: 100, y: 100 }, { x: 110, y: 240 }], { x: 100, y: 100 })).toEqual({ x: 100, y: 380 });
  });
});
