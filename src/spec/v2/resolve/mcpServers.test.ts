import { describe, it, expect } from 'vitest';
import { mcpServerSpecSchema } from '../../schema';
import { resolveMcpServers } from './mcpServers';
import type { McpServerSpecV2 } from '../mcpServers';

describe('resolveMcpServers', () => {

  it('resolves oauth.clientSecret through the host secret store', async () => {
    const servers: Record<string, McpServerSpecV2> = {
      api: {
        url: 'https://x.test/mcp',
        oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: { secret: 'cs' } },
      },
    };
    const result = await resolveMcpServers(servers, { resolveSecret: () => 's3' });
    expect(result.api).toEqual({
      url: 'https://x.test/mcp',
      oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: 's3' },
    });
    expect(mcpServerSpecSchema.safeParse(result.api).success).toBe(true);
  });
});
