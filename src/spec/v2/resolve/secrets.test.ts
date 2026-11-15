import { describe, it, expect } from 'vitest';
import { resolveSecretRef,  } from './secrets';

const FIELD = 'f';

describe('resolveSecretRef { env }', () => {

  it('falls back to the process env when host.env is absent', async () => {
    process.env.LOUSHO_TEST_SECRET_REF = 'p';
    try {
      await expect(resolveSecretRef({ env: 'LOUSHO_TEST_SECRET_REF' }, {}, FIELD)).resolves.toBe('p');
    } finally {
      delete process.env.LOUSHO_TEST_SECRET_REF;
    }
  });
});
