import { describe, expect, it } from 'vitest';
import { withFsRetry } from './fsRetry';

const fsError = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename 'a' -> 'b'`), { code });

describe('withFsRetry', () => {

  it('wraps a failure that outlasts the retries as LOUSHO_STORAGE_FAILED with the cause', async () => {
    const cause = fsError('EPERM');
    const failing = withFsRetry('replace b', async () => Promise.reject(cause), [0, 0]);
    await expect(failing).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED', cause });
    await expect(withFsRetry('replace b', async () => Promise.reject(cause), [0])).rejects.toThrow(/Could not replace b: EPERM/);
  });
});
