import { describe, it, expect, vi } from 'vitest';
import { IdleVersioner } from '../idleVersioner';

/**
 * A fake `setTimer`/`clearTimer` pair for `IdleVersioner`: `setTimer`
 * records the callback and returns the recorded entry as the handle;
 * `fire(handle)` runs it (the way a real timer would after `ms`).
 */
function fakeClock() {
  const scheduled = new Map<unknown, { fn: () => void; ms: number }>();
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const handle = {};
    scheduled.set(handle, { fn, ms });
    return handle;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    scheduled.delete(handle);
  });
  const fire = (handle: unknown) => scheduled.get(handle)?.fn();
  const lastHandle = () => [...scheduled.keys()].at(-1);
  return { scheduled, setTimer, clearTimer, fire, lastHandle };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('IdleVersioner', () => {

  it('a throwing capture is swallowed - the timer path and flushAll both survive it', async () => {
    const clock = fakeClock();
    const capture = vi.fn(async () => {
      throw new Error('store is gone');
    });
    const versioner = new IdleVersioner({ delayMs: 50, capture, ...clock });
    versioner.touch('ops');
    clock.fire(clock.lastHandle());
    await sleep(1);
    expect(capture).toHaveBeenCalledTimes(1);

    versioner.touch('ops');
    await expect(versioner.flushAll()).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
