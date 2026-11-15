import { describe, it, expect } from 'vitest';
import { agentSpecSchema,  } from './schema';

const base = { name: 'bot', prompt: 'hi', provider: { type: 'mock', model: 'm' } };

function issues(mcpServers: unknown): string[] {
  const result = agentSpecSchema.safeParse({ ...base, mcpServers });
  if (result.success) throw new Error('expected validation to fail');
  return result.error.issues.map((issue) => `${(issue.path ?? []).join('.')}: ${issue.message}`);
}

describe('AgentSpec.mcpServers', () => {

  it('rejects an entry with both command and url', () => {
    expect(issues({ both: { command: 'npx', url: 'https://example.com' } })[0]).toMatch(
      /^mcpServers\.both: AgentSpec validation failed: set either 'command'/
    );
  });

  it('accepts the legacy list form that lousho doctor used to read', () => {
    const parsed = agentSpecSchema.parse({
      ...base,
      mcpServers: [{ name: 'fs', command: 'npx' }, { url: 'https://example.com' }],
    });
    expect(parsed.mcpServers).toEqual({
      fs: { command: 'npx' },
      '#2': { url: 'https://example.com' },
    });
  });
});
