import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { inspectSpec } from './doctorSpec';
import type { DoctorEnvironment } from './doctorTypes';

describe('inspectSpec', () => {
  it('validates a version 2 spec with the v2 loader instead of reporting v1 errors', async () => {
    const specPath = path.resolve('templates/pr-reviewer/spec.yaml');
    const env = { specPath, isDirectory: () => false, loadSpec: () => { throw new Error('v1 loader must not run'); } } as unknown as DoctorEnvironment;
    const { checks, needs } = await inspectSpec(env);
    expect(checks).toEqual([expect.objectContaining({ id: 'spec', status: 'ok', finding: expect.stringContaining('valid version 2 spec') })]);
    expect([...needs.providers]).toEqual(['anthropic']);
  });
});
