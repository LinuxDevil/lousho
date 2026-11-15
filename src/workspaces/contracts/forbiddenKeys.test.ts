import { describe, it, expect } from 'vitest';
import { harnessKeyErrors } from './forbiddenKeys';

describe('harnessKeyErrors', () => {
  it('uses the given root in the message', () => {
    expect(harnessKeyErrors({ hooks: {} }, 'main-harness')).toEqual([{ path: ['hooks'], message: 'main-harness.hooks: harnesses describe the task; the runtime enforces hooks (R13)' }]);
  });
});
