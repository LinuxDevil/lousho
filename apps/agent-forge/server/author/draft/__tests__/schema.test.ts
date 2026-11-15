import { describe, expect, it } from 'vitest';
import {
  authorDraftSchema,
  authorPatchSchema,
  DRAFT_OMITTED_KEYS,
  FIELD_DESCRIPTIONS,
  NULLABLE_PATCH_KEYS,
} from '../schema';

/**
 * The draft/patch zod contracts of the Author's propose tools: which keys
 * a draft must, may and must not carry; the patch's optional/nullable
 * rules; and the `.describe()` coverage the model-facing JSON Schema
 * depends on (a spec key added without a FIELD_DESCRIPTIONS row fails
 * here, which is the point - the model only ever sees descriptions).
 */

const MINIMAL_DRAFT = {
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You triage support mail and pick the queue.',
};

describe('authorDraftSchema', () => {

  it.each([...DRAFT_OMITTED_KEYS, 'labels', 'bogusField'])('rejects the never-settable key %s', (key) => {
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, [key]: 'x' }).success).toBe(false);
  });
});

describe('authorPatchSchema', () => {

  it('accepts null on every spec-optional field except description', () => {
    for (const key of NULLABLE_PATCH_KEYS.filter((key) => key in authorDraftSchema.shape)) {
      expect(authorPatchSchema.safeParse({ [key]: null }).success).toBe(true);
    }
  });
});

describe('describe coverage', () => {

  it.each(Object.keys(authorDraftSchema.shape))('draft field %s is described', (key) => {
    expect(authorDraftSchema.shape[key]?.description).toBe(FIELD_DESCRIPTIONS[key]);
  });

  it.each(Object.keys(authorPatchSchema.shape))('patch field %s is described', (key) => {
    expect(authorPatchSchema.shape[key]?.description).toBe(FIELD_DESCRIPTIONS[key]);
  });
});
