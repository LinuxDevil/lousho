/**
 * The token cipher. AES-256-GCM via Web Crypto, a fresh IV per write,
 * the record key as AAD, an application-supplied key and no default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, SDKError } from '../execution/errors';
import { generateTokenKey, TokenCipher } from './tokenCipher';
import { SENTINEL_ACCESS } from './tokenStore.contract';

const KEY = generateTokenKey();

afterEach(() => { vi.unstubAllEnvs(); });

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as SDKError).code;
  }
}

describe('TokenCipher', () => {

  it('two writes of the same token produce different ciphertexts (fresh IV each time)', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const [a, b] = [await cipher.seal(SENTINEL_ACCESS, 'k'), await cipher.seal(SENTINEL_ACCESS, 'k')];
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('a ciphertext moved to another record key (AAD) fails', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const sealed = await cipher.seal(SENTINEL_ACCESS, 'github|user||alice');
    expect(await codeOf(cipher.open(sealed, 'github|user||mallory', 'token'))).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
  });

  it('a changed or malformed record fails the same way', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const sealed = await cipher.seal(SENTINEL_ACCESS, 'k');
    const [version, iv, data] = sealed.split('.');
    const flipped = `${data.slice(0, 4)}${data[4] === 'A' ? 'B' : 'A'}${data.slice(5)}`;
    for (const bad of [`${version}.${iv}.${flipped}`, `v2.${iv}.${data}`, 'garbage', `${version}.${iv}`, `${version}.!!!.${data}`, `${version}.${btoa('short')}.${data}`]) {
      expect(await codeOf(cipher.open(bad, 'k', 'token')), bad).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
    }
  });

  it('refuses a key that is not exactly 32 bytes of base64, without echoing it', () => {
    const short = btoa('sixteen-bytes!!!');
    for (const bad of [short, 'not base64 at all', `${KEY}AAAA`, '', KEY.slice(0, -1)]) {
      let thrown: unknown;
      try {
        TokenCipher.fromOption(bad, 'test');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, bad).toBeInstanceOf(ConfigurationError);
      expect((thrown as Error).message).toMatch(/must be 32 random bytes as base64/);
      if (bad) expect((thrown as Error).message).not.toContain(bad);
    }
    expect(() => TokenCipher.fromOption([KEY, short], 'test')).toThrow(/at index 1 in tokenKey/);
    vi.stubEnv('LOUSHO_TOKEN_KEY', short);
    expect(() => TokenCipher.fromOption(undefined, 'test')).toThrow(/in LOUSHO_TOKEN_KEY/);
  });
});
