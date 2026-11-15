import { describe, expect, it } from 'vitest';

import { SPEC_FIELD_ORDER } from '../../../../shared/specFields';
import { FIELD_LABELS, fieldLabel,  } from '../versionLabels';

describe('FIELD_LABELS', () => {
  it('labels every spec field the version records can report', () => {
    for (const field of SPEC_FIELD_ORDER) {
      expect(FIELD_LABELS[field], field).toBeTruthy();
    }
  });

  it('fieldLabel falls back to the raw key for unmapped fields', () => {
    expect(fieldLabel('tools')).toBe('Tools');
    expect(fieldLabel('someFutureField')).toBe('someFutureField');
  });
});
