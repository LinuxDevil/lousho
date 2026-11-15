/**
 * jsonSchemaToStandardSchema() / outputFromSpec(): a spec's plain JSON Schema
 * becomes a Standard Schema that validates through jsonSchemaToZod() and hands
 * providers the author's own schema back through schemaToJsonSchema(), so a v2
 * spec's `output: { jsonSchema }` drives createAgent({ output }) without zod.
 */
import { describe, it, expect } from 'vitest';
import { schemaToJsonSchema } from '../../utils/zodCompat';
import { outputFromSpec } from './jsonSchemaAdapter';

const person = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

describe('outputFromSpec', () => {
  it('keeps promptSchema: false and responseFormat: always', () => {
    const spec = outputFromSpec({ jsonSchema: person, promptSchema: false, responseFormat: 'always' });

    expect(spec.promptSchema).toBe(false);
    expect(spec.responseFormat).toBe('always');
    expect(schemaToJsonSchema(spec.schema)).toEqual(person);
  });
});
