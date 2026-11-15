/** RouteAuth(), the ordered list. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeAuth } from './routeAuth';
import { type AuthFn } from './types';
import { anonymous, apiToken, basic } from './basic';
import { jwt } from './jwt';
import { SECRET, bearer, hmacKey, signToken } from './__fixtures__/tokens';

const request = () => new Request('https://agent.test/chat');
const skip: AuthFn = () => null;

afterEach(() => { vi.restoreAllMocks(); });

describe('routeAuth', () => {

  it('answers 401 with the merged challenges when every entry skips', async () => {
    const outcome = await routeAuth(request(), [jwt({ secret: SECRET, audience: 'x' }), apiToken('t'), basic({ users: { a: 'b' }, realm: 'my "realm"' }), skip]);
    expect(outcome.ok).toBe(false);
    const { response } = outcome as { response: Response };
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toBe('Bearer, Basic realm="my \\"realm\\"", charset="UTF-8"');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('gives the same generic 401 whatever check failed', async () => {
    const hs = await hmacKey();
    const entries = [jwt({ secret: SECRET, audience: 'agent', issuer: 'https://iss.test' })];
    const bodies = new Set<string>();
    for (const token of [
      await signToken(hs, { aud: 'agent', iss: 'https://iss.test', exp: 1 }),
      await signToken(hs, { aud: 'other', iss: 'https://iss.test' }),
      await signToken(hs, { aud: 'agent', iss: 'https://other.test' }),
      'not-a-jwt',
    ]) {
      const outcome = await routeAuth(bearer(token), entries);
      const { response } = outcome as { response: Response };
      expect(response.status).toBe(401);
      const headerPairs: string[] = [];
      response.headers.forEach((value, key) => headerPairs.push(`${key}=${value}`));
      bodies.add(`${headerPairs.sort().join('|')} ${await response.text()}`);
    }
    expect(bodies.size).toBe(1);
  });

  it('an unexpected throw is a 500 whose body does not carry the error, and is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await routeAuth(request(), [
      () => {
        throw new Error('database password is hunter2');
      },
    ]);
    const { response } = outcome as { response: Response };
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('hunter2');
    expect(error).toHaveBeenCalled();
  });

  it('takes a single entry', async () => {
    expect(await routeAuth(request(), anonymous())).toMatchObject({ ok: true, principal: { id: 'anonymous' } });
  });
});
