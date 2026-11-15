import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecretsStore, maskKey } from './secretsStore';

describe('SecretsStore', () => {
  let baseDir: string;
  let store: SecretsStore;

  const savedEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-secrets-'));
    store = new SecretsStore(baseDir);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('reports no key stored for a fresh provider', () => {
    const status = store.list();
    expect(status).toEqual([
      { provider: 'openai', hasKey: false, masked: null, envKey: false },
      { provider: 'anthropic', hasKey: false, masked: null, envKey: false },
      { provider: 'openrouter', hasKey: false, masked: null, envKey: false },
    ]);
  });

  it('reports envKey from the provider env var, independent of a stored key', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key-placeholder';
    expect(store.list().map((s) => [s.provider, s.hasKey, s.envKey])).toEqual([
      ['openai', false, false],
      ['anthropic', false, true],
      ['openrouter', false, false],
    ]);
  });

  it('masks the stored key rather than exposing it in list()', () => {
    store.setKey('openai', 'sk-test-abc123XYZ');
    const status = store.list().find((s) => s.provider === 'openai');
    expect(status?.hasKey).toBe(true);
    expect(status?.masked).toBe(maskKey('sk-test-abc123XYZ'));
    expect(status?.masked).not.toContain('sk-test-abc123XYZ');
    expect(status?.masked).toBe('••••••••3XYZ');
  });

  it('writes ciphertext, not the plaintext key, to secrets.json', () => {
    store.setKey('openai', 'sk-super-secret-value');
    const raw = fs.readFileSync(path.join(baseDir, '.lousho', 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-value');
  });

  it('keeps the encryption key in a separate file from the ciphertext', () => {
    store.setKey('openai', 'sk-abc');
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'secrets.key'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'secrets.json'))).toBe(true);
  });

  describe('named secrets', () => {

    it('setSecret round-trips the value through getSecret and reports masked status', () => {
      const status = store.setSecret('GITHUB_TOKEN', 'ghp_abc123');
      expect(status.name).toBe('GITHUB_TOKEN');
      expect(status.hasValue).toBe(true);
      expect(status.masked).toBe('••••••••c123');
      expect(status.masked).not.toContain('ghp_abc123');
      expect(status.updatedAt).toEqual(expect.any(String));
      expect(store.getSecret('GITHUB_TOKEN')).toBe('ghp_abc123');
      expect(store.secretStatus('GITHUB_TOKEN')).toEqual(status);
    });

    it('rejects names that are not env-var-like and values outside 1..16384 or all whitespace', () => {
      for (const bad of ['1BAD', 'HAS-DASH', 'HAS SPACE', '', 'A'.repeat(65)]) {
        expect(() => store.setSecret(bad, 'v')).toThrow();
      }
      expect(() => store.setSecret('OK_NAME', '')).toThrow();
      expect(() => store.setSecret('OK_NAME', '   ')).toThrow();
      expect(() => store.setSecret('OK_NAME', 'x'.repeat(16_385))).toThrow();
      expect(store.listSecrets()).toEqual([]);
    });

    it('provider keys and named secrets coexist in one file without seeing each other', () => {
      store.setKey('openai', 'sk-provider-key');
      store.setSecret('OPENAI_WEBHOOK', 'whsec_1234');
      store.setSecret('GITHUB_TOKEN', 'ghp_abc123');
      // The provider list is unchanged in shape and ignores `named`.
      expect(store.list()).toEqual([
        { provider: 'openai', hasKey: true, masked: maskKey('sk-provider-key'), envKey: false },
        { provider: 'anthropic', hasKey: false, masked: null, envKey: false },
        { provider: 'openrouter', hasKey: false, masked: null, envKey: false },
      ]);
      expect(store.getKey('openai')).toBe('sk-provider-key');
      expect(store.listSecrets().map((s) => s.name)).toEqual(['GITHUB_TOKEN', 'OPENAI_WEBHOOK']);
      // Removing a named secret leaves the provider key alone, and vice versa.
      store.removeSecret('GITHUB_TOKEN');
      expect(store.getKey('openai')).toBe('sk-provider-key');
      store.removeKey('openai');
      expect(store.getSecret('OPENAI_WEBHOOK')).toBe('whsec_1234');
    });

    it('a tampered ciphertext decrypts to undefined and reports hasValue: false', () => {
      store.setSecret('GITHUB_TOKEN', 'ghp_abc123');
      const file = path.join(baseDir, '.lousho', 'secrets.json');
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      records.named.GITHUB_TOKEN.ciphertext = Buffer.from('tampered').toString('base64');
      fs.writeFileSync(file, JSON.stringify(records), 'utf8');
      expect(store.getSecret('GITHUB_TOKEN')).toBeUndefined();
      expect(store.secretStatus('GITHUB_TOKEN').hasValue).toBe(false);
      expect(store.secretStatus('GITHUB_TOKEN').masked).toBeNull();
    });

    it('writes ciphertext, not the plaintext secret, to secrets.json', () => {
      store.setSecret('GITHUB_TOKEN', 'ghp-super-secret-value');
      const raw = fs.readFileSync(path.join(baseDir, '.lousho', 'secrets.json'), 'utf8');
      expect(raw).not.toContain('ghp-super-secret-value');
      expect(JSON.parse(raw).named.GITHUB_TOKEN.ciphertext).toEqual(expect.any(String));
    });
  });
});
