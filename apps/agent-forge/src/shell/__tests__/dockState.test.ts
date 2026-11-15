import { beforeEach, describe, expect, it } from 'vitest';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_VIEWPORT_FRACTION,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_WIDTH_KEY,
  dockMaxWidth,
  readDockWidth,
} from '../dockState';

beforeEach(() => {
  installMemoryStorage();
});

describe('dockMaxWidth', () => {
  it('is min(640, floor(45% of vw)) and never below 360', () => {
    expect(dockMaxWidth(700)).toBe(DOCK_MIN_WIDTH); // 360 even though 45vw is less
    expect(dockMaxWidth(2000)).toBe(DOCK_MAX_WIDTH);
    expect(dockMaxWidth(1000)).toBe(Math.floor(1000 * DOCK_MAX_VIEWPORT_FRACTION)); // 450
  });
});

describe('readDockWidth', () => {

  it('falls back to the default on a non-numeric value or broken storage', () => {
    window.localStorage.setItem(DOCK_WIDTH_KEY, 'abc');
    expect(readDockWidth(1600)).toBe(DOCK_DEFAULT_WIDTH);
    breakStorage();
    expect(readDockWidth(1600)).toBe(DOCK_DEFAULT_WIDTH);
  });
});
