import { describe, it, expect } from 'vitest';
import { z as z3 } from 'zod/v3';
import { z as z4 } from 'zod/v4';
import { defineTool } from '../tools/defineTool';
import { validateToolArguments, ToolArgumentsValidationError } from '../execution/toolArgsValidation';
import type { ToolDescriptor } from '../types';
import {
  issueMessage,
  issuePath,
  type StandardSchemaV1,
} from './zodCompat';

/** A Standard Schema that is not zod: accepts strings, with an optional `~standard.jsonSchema`. */
function standardString(withJson: boolean): StandardSchemaV1<string> {
  const props = {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'not a string', path: [{ key: 'q' }] }] },
  };
  const jsonSchema = { input: () => ({ type: 'string' }) };
  return { '~standard': withJson ? { ...props, jsonSchema } : props } as StandardSchemaV1<string>;
}

// validateToolArguments reads only `inputSchema`; `tool` is a required ToolDescriptor field but unused here.
const descriptor = (inputSchema: unknown): ToolDescriptor => ({
  displayName: 't',
  inputSchema: inputSchema as StandardSchemaV1,
  tool: {} as unknown as ToolDescriptor['tool'],
});

describe('zodCompat', () => {

  it('words type mismatches the same on both majors', () => {
    const v3 = z3.object({ a: z3.string(), b: z3.number() }).safeParse({ b: 'x' });
    const v4 = z4.object({ a: z4.string(), b: z4.number() }).safeParse({ b: 'x' });
    const words = (issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>) =>
      issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`);
    expect(words(v3.error!.issues)).toEqual(['a: Required', 'b: Expected number, received string']);
    expect(words(v4.error!.issues)).toEqual(words(v3.error!.issues));
    expect(issuePath({ message: 'm' })).toBe('(root)');
  });

  it('validates with any Standard Schema, and only takes model-facing ones in defineTool', async () => {
    await expect(validateToolArguments('s', descriptor(standardString(false)), 'ok')).resolves.toBe('ok');
    const error = await validateToolArguments('s', descriptor(standardString(false)), 1).catch((e: unknown) => e);
    expect((error as ToolArgumentsValidationError).issues).toEqual([{ path: 'q', message: 'not a string' }]);
    expect(() => defineTool({ name: 's', description: 'd', input: standardString(false), execute: () => 1 })).toThrow(
      /zod schema as 'input'/
    );
    // Its JSON Schema is a string, which no provider takes as tool parameters.
    expect(() => defineTool({ name: 's', description: 'd', input: standardString(true), execute: (q) => q })).toThrow(/must be a z\.object\(\).*got string/);
    const objectSchema = { '~standard': { ...standardString(true)['~standard'], jsonSchema: { input: () => ({ type: 'object', properties: { q: { type: 'string' } } }) } } };
    expect(defineTool({ name: 's', description: 'd', input: objectSchema as StandardSchemaV1<string>, execute: (q) => q }).name).toBe('s');
  });
});
