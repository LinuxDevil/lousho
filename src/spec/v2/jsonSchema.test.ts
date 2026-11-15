/**
 * Tests for S17: agentSpecV2JsonSchema export
 */
import { describe, it, expect } from 'vitest';
import { agentSpecV2JsonSchema, SPEC_FIELD_DESCRIPTIONS } from './jsonSchema';
import { agentSpecV2Schema } from './schema';

describe('agentSpecV2JsonSchema', () => {
  it('returns a draft-7 object schema with required fields', () => {
    const schema = agentSpecV2JsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('AgentSpec v2');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const required = schema.required as string[];
    expect(required).toContain('version');
    expect(required).toContain('name');
    expect(required).toContain('model');
    expect(required).toContain('instructions');
  });

  it('SPEC_FIELD_DESCRIPTIONS has no stale keys', () => {
    const shape = agentSpecV2Schema.shape;
    for (const key of Object.keys(SPEC_FIELD_DESCRIPTIONS)) {
      expect(shape[key]).toBeDefined();
    }
  });
});
