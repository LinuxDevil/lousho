import { describe, it, expect } from 'vitest';
import { issueMessage, issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function parse(mcpServers: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, mcpServers });
}

describe('agentSpecV2Schema mcpServers', () => {

  it('accepts a SecretRef in oauth.clientSecret', () => {
    const result = parse({
      api: { url: 'https://x.test/mcp', oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: { secret: 'cs' } } },
    });
    expect(result.success).toBe(true);
  });

  it('reports a bad ref at mcpServers.<server>.env.<KEY>.env', () => {
    const result = parse({ gh: { command: 'npx', env: { T: { env: 'bad name' } } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePath(result.error.issues[0])).toBe('mcpServers.gh.env.T.env');
  });

  it("keeps v1's message for values that are neither strings nor refs", () => {
    const result = parse({ gh: { command: 'npx', env: { T: 42 } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issueMessage(issue).includes('must be a map of string to string'))).toBe(true);
  });
});
