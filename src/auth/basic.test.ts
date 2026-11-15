/** Basic(), apiToken() and anonymous(). */
import { describe, expect, it, vi } from 'vitest';
import { SDKError } from '../utils/sdkError';
import { apiToken, basic } from './basic';
import * as encoding from './encoding';

describe('basic()', () => {

  it('refuses unusable users at construction', () => {
    for (const users of [{}, { '': 'x' }, { 'a:b': 'x' }, { a: '' }] as Record<string, string>[]) {
      expect(() => basic({ users }), JSON.stringify(users)).toThrow(SDKError);
    }
  });
});

describe('apiToken() and anonymous()', () => {
  it('accepts the bearer token as a service principal, in constant time', async () => {
    const auth = apiToken('sekret-token', { id: 'ci' });
    const spy = vi.spyOn(encoding, 'sameSecret');
    const ok = new Request('https://agent.test/', { headers: { authorization: 'Bearer sekret-token' } });
    expect(await auth(ok)).toEqual({ id: 'ci', type: 'service', authenticator: 'api-token' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await auth(new Request('https://agent.test/', { headers: { authorization: 'Bearer sekret-token-' } }))).toBeNull();
    expect(await auth(new Request('https://agent.test/'))).toBeNull();
    expect(await apiToken('t')(new Request('https://agent.test/', { headers: { authorization: 'Bearer t' } }))).toMatchObject({ id: 'api-token' });
    expect(() => apiToken('')).toThrow(SDKError);
  });
});
