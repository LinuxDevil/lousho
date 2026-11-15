import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionUtils, generatePassword, DTOEncryptionFilter, DecryptionError } from './crypto';

describe('Security - Crypto', () => {
  describe('EncryptionUtils', () => {
    let encryptionUtils: EncryptionUtils;
    const testSecret = 'test-secret-key-12345';

    beforeEach(() => {
      encryptionUtils = new EncryptionUtils(testSecret);
    });

    it('should produce different ciphertexts for same plaintext', async () => {
      const text = 'test';
      const encrypted1 = await encryptionUtils.encrypt(text);
      const encrypted2 = await encryptionUtils.encrypt(text);
      // Due to random IV, encryptions should be different
      expect(encrypted1).not.toBe(encrypted2);
      // But both should decrypt to the same value
      expect(await encryptionUtils.decrypt(encrypted1)).toBe(text);
      expect(await encryptionUtils.decrypt(encrypted2)).toBe(text);
    });
  });

  describe('salt uniqueness', () => {
    it('produces different salts for identical plaintext', async () => {
      const testSecret = 'test-secret-key-12345';
      const encryptionUtils = new EncryptionUtils(testSecret);
      const a = await encryptionUtils.encrypt('same-plaintext');
      const b = await encryptionUtils.encrypt('same-plaintext');
      const saltA = a.slice(0, 32);
      const saltB = b.slice(0, 32);
      expect(saltA).not.toBe(saltB);
    });
  });

  describe('generatePassword', () => {
    it('should generate a password', () => {
      const password = generatePassword();
      expect(password).toBeDefined();
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThan(0);
    });
  });

  describe('DTOEncryptionFilter', () => {
    let filter: DTOEncryptionFilter<Record<string, unknown>>;
    const testSecret = 'test-secret-key-12345';

    beforeEach(() => {
      filter = new DTOEncryptionFilter(testSecret);
    });

    it('should encrypt only specified fields when settings provided', async () => {
      const dto = { name: 'John', age: 30, email: 'john@example.com' };
      const settings = { encryptedFields: ['email'] };

      const encrypted = await filter.encrypt(dto, settings);

      expect(encrypted.name).toBe(dto.name); // Not encrypted
      expect(encrypted.email).not.toBe(dto.email); // Encrypted
      expect(encrypted.age).toBe(dto.age); // Not encrypted

      const decrypted = await filter.decrypt(encrypted, settings);
      expect(decrypted).toEqual(dto);
    });

    it('should handle Date objects', async () => {
      const now = new Date();
      const dto = { timestamp: now, name: 'Test' };
      const encrypted = await filter.encrypt(dto);
      const decrypted = await filter.decrypt(encrypted);

      // Date is converted to ISO string during encryption
      expect(decrypted.timestamp).toBe(now.toISOString());
    });

    it('should propagate DecryptionError on tampered ciphertext', async () => {
      const dto = { name: 'not-a-real-envelope' };
      await expect(filter.decrypt(dto)).rejects.toThrow(DecryptionError);
    });
  });
});
