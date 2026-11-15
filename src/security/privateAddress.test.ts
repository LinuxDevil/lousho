import { describe, it, expect, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { pinnedLookup, resolvePublicAddresses, SsrfBlockedError, findSsrfBlockedError } from './privateAddress';

/** Stubs `dns.promises.lookup` (the resolver the module uses) with a fixed answer per host. */
function stubResolver(answers: Record<string, LookupAddress[]>) {
  return vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string) => {
    const answer = answers[hostname];
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return answer;
  }) as unknown as typeof dns.promises.lookup);
}

function lookupOnce(fn: ReturnType<typeof pinnedLookup>, host: string, options: dns.LookupOptions = {}) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    fn(host, options, (error, address, family) => (error ? reject(error) : resolve({ address, family })));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePublicAddresses', () => {

  it('checks IP literals without resolving them', async () => {
    const spy = stubResolver({});
    await expect(resolvePublicAddresses('[::1]')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolvePublicAddresses('203.0.113.10')).resolves.toEqual([{ address: '203.0.113.10', family: 4 }]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pinnedLookup', () => {
  it('throws SsrfBlockedError for a name resolving to any private address', async () => {
    stubResolver({ 'rebind.test': [{ address: '127.0.0.1', family: 4 }] });
    await expect(lookupOnce(pinnedLookup(), 'rebind.test')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('answers `all: true` with every checked address and honors `family`', async () => {
    stubResolver({ 'dual.test': [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::1', family: 6 }] });
    await expect(lookupOnce(pinnedLookup(), 'dual.test', { all: true })).resolves.toMatchObject({
      address: [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::1', family: 6 }],
    });
    await expect(lookupOnce(pinnedLookup(), 'dual.test', { family: 6 })).resolves.toEqual({ address: '2001:db8::1', family: 6 });
  });
});

describe('findSsrfBlockedError', () => {
  it('finds the error on a cause chain', () => {
    const blocked = new SsrfBlockedError('x.test');
    const wrapped = new TypeError('fetch failed', { cause: new Error('connect', { cause: blocked }) });
    expect(findSsrfBlockedError(wrapped)).toBe(blocked);
    expect(findSsrfBlockedError(new Error('other'))).toBeUndefined();
  });
});
