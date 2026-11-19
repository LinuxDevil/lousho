import { describe, expect, it } from 'vitest';
import { readToolFactories } from '../tools/readTools';
import type { AuthorToolDeps } from '../tools/index';
import type { AuthorTurn } from '../turnRunner';

describe('listMcpServers', () => {
  it('lists Profile MCP connectors with source profile and header names only', async () => {
    const deps = {
      workspace: async () => ({ repo: { listIds: () => [] } }),
      catalog: { listRegistryMcpServers: async () => [] },
      secrets: {
        secretStatus: () => undefined,
        mcpConnectors: () => [
          { name: 'tracker', url: 'https://tracker.example.com/mcp', tokenSecret: 'MCP_TRACKER_TOKEN' },
          { name: 'wiki', url: 'https://wiki.example.com/mcp' },
        ],
      },
    } as unknown as AuthorToolDeps;
    const turn = { state: new Map<string, unknown>(), stepsRemaining: () => 12 } as unknown as AuthorTurn;
    const tool = readToolFactories[readToolFactories.length - 1](turn, deps);
    const result = (await (tool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ items: unknown[] }> }).execute({}, { toolCallId: 'c' })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items).toEqual([
      { key: 'tracker', transport: 'http', url: 'https://tracker.example.com/mcp', headersKeys: ['Authorization'], usedBy: [], source: 'profile' },
      { key: 'wiki', transport: 'http', url: 'https://wiki.example.com/mcp', usedBy: [], source: 'profile' },
    ]);
    expect(JSON.stringify(result)).not.toContain('MCP_TRACKER_TOKEN');
  });
});
