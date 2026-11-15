import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  loadPendingRequest,
  PENDING_REQUEST_KEY,
  REATTACH_GAVE_UP,
  REATTACH_MAX_ATTEMPTS,
  REATTACH_TIMEOUT_MS,
  savePendingRequest,
} from '../reattach';

describe('reattach constants', () => {
  it('pins the values the hook retries and gives up with', () => {
    expect(REATTACH_TIMEOUT_MS).toBe(5000);
    expect(REATTACH_MAX_ATTEMPTS).toBe(3);
    expect(REATTACH_GAVE_UP).toContain('Could not reconnect');
    expect(PENDING_REQUEST_KEY).toBe('forge.author.pendingRequest');
  });
});

describe('pending-request storage', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    window.localStorage.removeItem(PENDING_REQUEST_KEY);
  });

  it('round-trips a PendingRequest and clears it on null', () => {
    const pending = { sessionId: 'sess-1', requestId: 'req-aa04-0001', lastSeq: 7 };
    expect(loadPendingRequest()).toBeNull();
    savePendingRequest(pending);
    expect(loadPendingRequest()).toEqual(pending);
    savePendingRequest(null);
    expect(loadPendingRequest()).toBeNull();
  });

  it('returns null for malformed stored JSON or a wrong shape', () => {
    window.localStorage.setItem(PENDING_REQUEST_KEY, '{not json');
    expect(loadPendingRequest()).toBeNull();
    window.localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify({ sessionId: 's' }));
    expect(loadPendingRequest()).toBeNull();
    window.localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify('a string'));
    expect(loadPendingRequest()).toBeNull();
  });

  it('survives a throwing localStorage (save does not throw, load returns null)', () => {
    breakStorage(); // every getItem/setItem throws, as blocked site data does
    expect(() => savePendingRequest({ sessionId: 's', requestId: 'r', lastSeq: 1 })).not.toThrow();
    expect(loadPendingRequest()).toBeNull();
    expect(() => savePendingRequest(null)).not.toThrow();
  });
});
