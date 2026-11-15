import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(tools: unknown) {
  return { ...base, tools };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 tools', () => {

  it('suggests the builtin a kebab name is a typo of', () => {
    const error = thrown(spec([{ builtin: 'web-fetch' }]));
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('tools.0.builtin');
    expect(error.message).toContain("did you mean 'web_fetch'");
  });

  it('requires exactly one tool-ref kind key', () => {
    for (const tools of [[{ builtin: 'x', file: 'a.ts' }], [{}], ['web_fetch']]) {
      const error = thrown(spec(tools));
      expect(error.errors).toHaveProperty('tools.0');
      expect(error.message).toContain('exactly one of builtin, registry, file, integration, openapi, hosted, hub');
    }
  });

  it('requires file_search options (vectorStoreIds)', () => {
    const error = thrown(spec([{ hosted: 'file_search' }]));
    expect(error.errors).toHaveProperty('tools.0.options.vectorStoreIds');
  });

  it("reports a registry 'version' as not supported yet", () => {
    const error = thrown(spec([{ registry: 'github-issues', version: '1.0.0' }]));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('tools.0.version');
  });

  it('requires an https openapi url unless the host is loopback', () => {
    const error = thrown(spec([{ openapi: { url: 'http://api.example.com/x' } }]));
    expect(error.message).toContain('must be an https URL');
    const ok = agentSpecV2Schema.safeParse(spec([{ openapi: { url: 'http://localhost:3000/openapi.json' } }]));
    expect(ok.success).toBe(true);
  });
});
