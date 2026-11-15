import { describe, it, expect } from 'vitest';
import { orderInstructionFiles, sharedReferenceSchema } from './shared';

describe('shared layout', () => {

  it('orders the same however the input is ordered', () => {
    const a = ['shared/instructions/b.md', 'shared/instructions/a.md'];
    expect(orderInstructionFiles(a)).toEqual(orderInstructionFiles([...a].reverse()));
    expect(orderInstructionFiles([])).toEqual([]);
  });
});

describe('sharedReferenceSchema', () => {

  it.each([
    'shared:knowledge/../policies/policy.json',
  ])('rejects %s', (ref) => {
    expect(sharedReferenceSchema.safeParse(ref).success).toBe(false);
  });
});
