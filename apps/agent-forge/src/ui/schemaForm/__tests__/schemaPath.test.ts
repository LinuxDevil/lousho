import { describe, expect, it } from 'vitest';

import { resolveRef, setAtPath } from '../schemaPath';

import { SCHEMA } from './fixture';

describe('setAtPath', () => {

  it('creates missing containers along the path', () => {
    expect(setAtPath(undefined, ['x', 'y'], 1)).toEqual({ x: { y: 1 } });
  });
});

describe('resolveRef', () => {

  it('returns {} for an unknown ref', () => {
    expect(resolveRef(SCHEMA, { $ref: '#/nope' })).toEqual({});
    expect(resolveRef(SCHEMA, { $ref: '#/definitions/missing' })).toEqual({});
  });
});
