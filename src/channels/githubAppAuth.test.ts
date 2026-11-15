/**
 * GitHub App authentication - PKCS#1 and PKCS#8 private keys, the RS256
 * JWT, and the installation token cache. A key pair is generated in the test;
 * a fake `fetch` stands in for the REST API.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createInstallationTokens, pemToPkcs8, signAppJwt } from './githubAppAuth';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('pemToPkcs8', () => {

  it('accepts a key whose newlines are the two characters backslash and n, and rejects anything else', () => {
    expect(pemToPkcs8(pkcs8.replace(/\n/g, '\n')).length).toBeGreaterThan(1000);
    expect(() => pemToPkcs8('not a key')).toThrow(/PEM private key/);
    expect(() => pemToPkcs8('-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----')).toThrow(/valid PEM/);
  });
});

describe('signAppJwt', () => {

  it('refuses a key that is PEM but not an RSA key, without echoing it', async () => {
    const bogus = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';

    await expect(signAppJwt('1', bogus)).rejects.toThrow(/could not be imported/);
  });
});

describe('createInstallationTokens', () => {
  const clock = { now: 1_700_000_000_000 };

  it('a failed exchange names the call and status, never the JWT, and is retried next time', async () => {
    let status = 401;
    const fetch = vi.fn(async () => (status === 401 ? new Response('{"message":"bad"}', { status }) : new Response(JSON.stringify({ token: 'ghs_ok', expires_at: new Date(clock.now + 3_600_000).toISOString() }), { status: 201 })));
    const tokens = createInstallationTokens({ appId: '1', privateKey: pkcs1, fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock.now });

    const error = (await tokens(5).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('githubChannel: POST /app/installations/5/access_tokens failed: 401');
    expect(error).toMatchObject({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED' });
    status = 201;
    expect(await tokens(5)).toBe('ghs_ok');
  });
});
