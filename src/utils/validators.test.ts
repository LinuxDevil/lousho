import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  safeValidate,
  isValidEmail,
  sanitizeString,
} from './validators';

describe('validator utilities', () => {
  describe('schema validation', () => {

    it('should return error on invalid data', () => {
      const schema = z.object({ email: z.string().email() });
      const result = safeValidate(schema, { email: 'invalid' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('email validation', () => {

    it('should reject invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('test@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
    });
  });

  describe('string sanitization', () => {
    it('should sanitize HTML characters', () => {
      const input = '<script>alert("xss")</script>';
      const sanitized = sanitizeString(input);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toContain('&lt;');
      expect(sanitized).toContain('&gt;');
    });
  });
});

