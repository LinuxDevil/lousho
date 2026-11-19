import { describe, expect, it } from 'vitest';
import { outsideAgentLocks, withAgentLock } from './atomic';

describe('outsideAgentLocks', () => {
  it('lets work started under a lock take the same lock once it is released', async () => {
    let later: Promise<number> | undefined;
    await withAgentLock('a', async () => {
      outsideAgentLocks(() => {
        later = withAgentLock('a', async () => 1);
      });
      await expect(withAgentLock('a', async () => 2)).rejects.toThrow('re-entered');
    });
    await expect(later).resolves.toBe(1);
  });
});
