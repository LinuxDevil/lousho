import { describe, it, expect } from 'vitest';
import { noopLogger } from './logger';

describe('noopLogger', () => {
  it('calling all four methods does not throw', () => {
    expect(() => {
      noopLogger.debug('debug message', { a: 1 });
      noopLogger.info('info message');
      noopLogger.warn('warn message', { b: 2 });
      noopLogger.error('error message', { c: 3 });
    }).not.toThrow();
  });
});
