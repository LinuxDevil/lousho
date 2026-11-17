import { describe, expect, it } from 'vitest';
import { REATTACH_MAX_ATTEMPTS, reattachTimeoutVerdict } from '../reattach';

describe('reattachTimeoutVerdict', () => {
  it('keeps waiting on an open socket while a slow reply is still running', () => {
    for (let attempts = 0; attempts < REATTACH_MAX_ATTEMPTS + 2; attempts++) {
      expect(reattachTimeoutVerdict({ running: true, socketOpen: true, attempts })).toBe('done');
    }
  });

  it('retries a closed socket, then gives up', () => {
    expect(reattachTimeoutVerdict({ running: true, socketOpen: false, attempts: 0 })).toBe('retry');
    expect(reattachTimeoutVerdict({ running: true, socketOpen: false, attempts: REATTACH_MAX_ATTEMPTS - 1 })).toBe('gaveUp');
  });

  it('is done once the reply settled', () => {
    expect(reattachTimeoutVerdict({ running: false, socketOpen: false, attempts: 0 })).toBe('done');
  });
});
