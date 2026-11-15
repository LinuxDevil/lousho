/**
 * The error-code registry, the codes used in src/ and docs/errors.md
 * cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_DOCS_URL, errorDocsUrl, errorHelp } from './errorCodes';

describe('error codes', () => {

  it('docs links point at the code section anchors', () => {
    expect(errorDocsUrl('LOUSHO_PEER_MISSING')).toBe(`${ERROR_DOCS_URL}#lousho_peer_missing`);
    expect(errorHelp('LOUSHO_PEER_MISSING')).toEqual({
      hint: ERROR_CODES.LOUSHO_PEER_MISSING,
      docs: `${ERROR_DOCS_URL}#lousho_peer_missing`,
    });
    expect(errorHelp('NOT_A_CODE')).toBeUndefined();
    expect(errorHelp('toString')).toBeUndefined();
  });
});
