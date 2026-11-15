import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadMcpTools } from './McpToolLoader';

describe('loadMcpTools', () => {

  it('skips a tool whose schema cannot be converted, warns, reports it and loads the rest', async () => {
    const badTool = {
      name: 'broken',
      get inputSchema(): never {
        throw new Error('boom');
      },
    };
    const goodTool = {
      name: 'fine',
      description: 'ok',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
    };
    const client = {
      listTools: async () => ({ tools: [badTool, goodTool] }),
    } as unknown as Client;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onSkip = vi.fn();

    const descriptors = await loadMcpTools(client, 'srv', { logger, onSkip });

    expect(Object.keys(descriptors)).toEqual(['srv__fine']);
    expect(onSkip).toHaveBeenCalledWith({ name: 'broken', reason: 'boom' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0][0] as string;
    expect(message).toContain('srv');
    expect(message).toContain('broken');
    expect(message).toContain('boom');
  });
});

describe('loadMcpTools tool names', () => {
  const schema = { type: 'object', properties: {} };
  const named = (...names: string[]) => {
    const callTool = vi.fn(async (params: { name: string }) => ({ content: [{ type: 'text', text: `ran ${params.name}` }] }));
    return { client: { listTools: async () => ({ tools: names.map((name) => ({ name, inputSchema: schema })) }), callTool } as unknown as Client, callTool };
  };
  const valid = /^[a-zA-Z0-9_-]{1,64}$/;

  it('sanitizes names to the provider-safe charset and length, and calls the server with the original name', async () => {
    const long = 'x'.repeat(70);
    const { client, callTool } = named('vps.list', 'get metrics', 'ns/tool', long, 'execute');
    const tools = await loadMcpTools(client, 'hostinger.vps');
    const keys = Object.keys(tools);
    expect(keys.slice(0, 3)).toEqual(['hostinger_vps__vps_list', 'hostinger_vps__get_metrics', 'hostinger_vps__ns_tool']);
    expect(keys.every((key) => valid.test(key))).toBe(true);
    expect(keys.every((key) => tools[key].name === key)).toBe(true);
    expect(tools.hostinger_vps__vps_list.metadata?.mcp).toMatchObject({ server: 'hostinger.vps', tool: 'vps.list' });
    const longKey = keys[3];
    expect(longKey).toHaveLength(64);
    await tools[longKey].execute!({}, { toolCallId: 'c1', messages: [] } as never);
    expect(callTool).toHaveBeenLastCalledWith({ name: long, arguments: {} }, undefined, {});
  });

  it('gives names that collide after sanitizing distinct keys', async () => {
    const { client, callTool } = named('a.b', 'a/b', 'a_b');
    const tools = await loadMcpTools(client, 'srv');
    const keys = Object.keys(tools);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((key) => valid.test(key))).toBe(true);
    for (const key of keys) await tools[key].execute!({}, { toolCallId: 'c', messages: [] } as never);
    expect(callTool.mock.calls.map(([params]) => params.name).sort()).toEqual(['a.b', 'a/b', 'a_b']);
  });
});

describe('loadMcpTools include / exclude', () => {
  const schema = { type: 'object', properties: {} };
  const client = {
    listTools: async () => ({ tools: ['search', 'execute', 'multi-execute'].map((name) => ({ name, inputSchema: schema })) }),
  } as unknown as Client;

  it('include keeps only the listed tools; exclude drops the listed ones', async () => {
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { include: ['search', 'execute'] } }))).toEqual(['s__search', 's__execute']);
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { exclude: ['multi-execute'] } }))).toEqual(['s__search', 's__execute']);
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { include: ['search', 'execute'], exclude: ['execute'] } }))).toEqual(['s__search']);
  });
});
