/** Run lease records of the file and SQLite stores: when a lease is free to take. */
import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { leaseAvailable, newLeaseRecord, parseLeaseRecord } from './leaseRecord';

describe('run lease records', () => {
  it('a missing, own, long-expired or unreadable lease is free; a live one of another owner is not', () => {
    const live = newLeaseRecord('claim:a', 60_000);
    expect(live).toMatchObject({ host: hostname(), ttlMs: 60_000 });
    expect(leaseAvailable(undefined, 'claim:b')).toBe(true);
    expect(leaseAvailable(live, 'claim:a')).toBe(true);
    expect(leaseAvailable(live, 'claim:b')).toBe(false);
    for (const raw of [undefined, 'not json', 'null', '{"owner":1}', '{"owner":"a"}']) expect(parseLeaseRecord(raw)).toBeUndefined();
    expect(parseLeaseRecord(JSON.stringify(live))).toEqual(live);
  });

  it('an expired lease is taken only after one more lease period (clocks of two replicas may disagree)', () => {
    const lease = newLeaseRecord('claim:a', 30_000);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 1 }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 29_000 }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 30_001 }, 'claim:b')).toBe(true);
    // A record without its period (written by an earlier release) has no grace.
    expect(leaseAvailable({ owner: 'claim:a', expiresAt: Date.now() - 1 }, 'claim:b')).toBe(true);
  });
});
