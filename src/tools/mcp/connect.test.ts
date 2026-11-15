import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import { defineTool } from '../defineTool';
import type { Logger } from '../../execution/logger';
import { connectMcp, McpStartError, type McpConnections } from './connect';
import { serveMcp } from './server/serveMcp';

const fixture = fileURLToPath(new URL('./__fixtures__/stdioServer.mjs', import.meta.url));
const failing = fileURLToPath(new URL('./__fixtures__/failingServer.mjs', import.meta.url));
const stdio = (prefix = '') => ({ command: process.execPath, args: [fixture], env: { FIXTURE_PREFIX: prefix } });

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(...args: Parameters<typeof connectMcp>): Promise<McpConnections> {
  const connections = await connectMcp(...args);
  closers.push(() => connections.close());
  return connections;
}

async function callEcho(connections: McpConnections, name: string, text: string): Promise<unknown> {
  return connections.tools[name].tool.execute!({ text }, { toolCallId: 'c1', messages: [] });
}

function warnLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('connectMcp', () => {

  it("a call that fails with the SDK's 'Not connected' reconnects and is sent once more", async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'lousho-mcp-')), 'starts.log');
    closers.push(async () => rmSync(dirname(log), { recursive: true, force: true }));
    const mcp = await connect({ files: { ...stdio(), env: { FIXTURE_START_LOG: log } } });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const spy = vi.spyOn(Client.prototype, 'callTool').mockRejectedValueOnce(new Error('Not connected'));
    try {
      await expect(callEcho(mcp, 'files__echo', 'again')).resolves.toMatchObject({ text: 'again' });
    } finally {
      spy.mockRestore();
    }
    expect(mcp.status()).toEqual({ files: 'connected' });
    expect(readFileSync(log, 'utf8').match(/start/g)).toHaveLength(2);
  });

  it('timeoutMs on the server entry bounds each tool call', async () => {
    const mcp = await connect({ slow: { ...stdio(), env: { FIXTURE_DELAY_MS: '5000' }, timeoutMs: 100 } });
    await expect(callEcho(mcp, 'slow__echo', 'x')).rejects.toThrow(/timed out/i);
  });

  it('a server that exits while starting fails with LOUSHO_MCP_START_FAILED, its exit code and its last stderr lines', async () => {
    const error = (await connectMcp({ broken: { command: process.execPath, args: [failing], env: { FIXTURE_MODE: 'exit' }, stderr: 'capture' } }).catch(
      (e: unknown) => e
    )) as McpStartError;
    expect(error).toBeInstanceOf(McpStartError);
    expect(error.code).toBe('LOUSHO_MCP_START_FAILED');
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toContain('npm error 404 Not Found');
    expect(error.stderr).not.toMatch(/^log line 1$/m);
    expect(error.message).toMatch(/MCP server 'broken' failed to start/);
    expect(error.message).toContain('exit code 3');
    expect(error.message).toContain('npm error 404');
  });

  it('connectTimeoutMs bounds the start of a server that never answers', async () => {
    const started = Date.now();
    const error = (await connectMcp({
      mute: { command: process.execPath, args: [failing], env: { FIXTURE_MODE: 'silent' }, connectTimeoutMs: 200 },
    }).catch((e: unknown) => e)) as McpStartError;
    expect(error).toBeInstanceOf(McpStartError);
    expect(error.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('connects a streamable HTTP server with headers', async () => {
    const searchDocs = defineTool({
      name: 'search_docs',
      description: 'Search the docs',
      input: z.object({ query: z.string() }),
      execute: ({ query }) => `results for ${query}`,
    });
    const server = await serveMcp({
      agent: createAgent({ provider: mockModel(['ok']) }),
      name: 'docs',
      tools: [searchDocs],
      transport: { type: 'http', port: 0, auth: { type: 'bearer', token: 'secret' } },
      warn: () => {},
    });
    closers.push(() => server.close());

    const mcp = await connect({ docs: { url: server.url!, headers: { Authorization: 'Bearer secret' } } });
    expect(Object.keys(mcp.tools).sort()).toEqual(['docs__docs', 'docs__search_docs']);
    const result = await mcp.tools.docs__search_docs.tool.execute!({ query: 'mcp' }, { toolCallId: 'c1', messages: [] });
    expect(result).toMatchObject({ text: 'results for mcp' });

    await expect(connectMcp({ docs: { url: server.url! } })).rejects.toThrow(/'docs' failed to connect/);
  });
});

describe('createAgent({ mcpServers })', () => {

  it('stream() waits for the servers, and ready() / close() are no-ops without them', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'x' } }] }, 'streamed']);
    const agent = createAgent({ provider: model, mcpServers: { files: { ...stdio(), approval: 'annotations' } } });
    closers.push(() => agent.close());
    const types: string[] = [];
    for await (const event of agent.stream('go')) types.push(event.type);
    expect(types).toContain('tool.done');
    expect(types.at(-1)).toBe('run.done');

    const plain = createAgent({ provider: mockModel(['hi']) });
    await expect(plain.ready()).resolves.toBeUndefined();
    await expect(plain.close()).resolves.toBeUndefined();
  });

  it('ready() after close() reconnects the servers', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'lousho-mcp-')), 'starts.log');
    closers.push(async () => rmSync(dirname(log), { recursive: true, force: true }));
    const agent = createAgent({ provider: mockModel(['a']), mcpServers: { files: { ...stdio(), env: { FIXTURE_START_LOG: log } } } });
    closers.push(() => agent.close());
    await agent.ready();
    await agent.close();
    await agent.ready();
    expect(readFileSync(log, 'utf8').match(/start/g)).toHaveLength(2);
  });

  it('an optional server that cannot connect is left out with a warning; the agent still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const model = mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'ping' } }] }, 'done']);
      const agent = createAgent({
        provider: model,
        mcpServers: { broken: { command: 'lousho-no-such-command-z4', optional: true }, files: { ...stdio('mcp:'), approval: 'never' } },
      });
      closers.push(() => agent.close());
      const result = await agent.send('echo ping');
      expect(result.text).toBe('done');
      expect(model.calls[0].tools?.map((t) => t.function.name)).toEqual(['files__echo', 'files__wipe']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping MCP server 'broken'"), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('an optional server connects in the background: send() does not wait for it, its tools join when it lands', async () => {
    const started = Date.now();
    const model = mockModel(['done', 'done again']);
    const agent = createAgent({
      provider: model,
      mcpServers: {
        slow: { ...stdio(), optional: true, env: { FIXTURE_START_DELAY_MS: '1500' }, approval: 'never' },
      },
    });
    closers.push(() => agent.close());

    const result = await agent.send('hi');
    expect(result.text).toBe('done');
    // The 1.5s connect must not have been awaited by the first run...
    expect(Date.now() - started).toBeLessThan(1500);
    // ...so its model call saw no optional tools yet.
    expect(model.calls[0].tools?.map((t) => t.function.name) ?? []).not.toContain('slow__echo');

    // Once the background connect lands, the next run offers them.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const again = await agent.send('again');
    expect(again.text).toBe('done again');
    expect(model.calls[1].tools?.map((t) => t.function.name)).toEqual(['slow__echo', 'slow__wipe']);
  });

  it('an MCP tool with the name of a local tool is refused (LOUSHO_CONFIG_INVALID)', async () => {
    let ran = false;
    const local = defineTool({
      name: 'files__wipe',
      description: 'local, gated',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        ran = true;
        return 'local';
      },
    });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'files__wipe', args: {} }] }, 'done']),
      tools: [local],
      mcpServers: { files: { ...stdio(), approval: 'never' } },
    });
    closers.push(() => agent.close());
    await expect(agent.send('go')).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringContaining("'files__wipe'") });
    expect(ran).toBe(false);
  });

  it('an approval function sees the call arguments', async () => {
    const wipe = (path: string, id: string) => ({ toolCalls: [{ name: 'files__wipe', args: { path }, id }] });
    const agent = createAgent({
      provider: mockModel([wipe('/tmp/x', 'call_tmp'), wipe('/data', 'call_data'), 'done']),
      mcpServers: { files: { ...stdio(), approval: ({ args }) => !String(args?.path).startsWith('/tmp/') } },
    });
    closers.push(() => agent.close());
    const paused = await agent.send('clean up');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(JSON.stringify(paused.messages)).toContain('wiped /tmp/x');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ toolName: 'files__wipe', args: { path: '/data' } });
  });
});

describe('MCP pagination, tools/list_changed and crashes', () => {
  const edgeFixture = fileURLToPath(new URL('./__fixtures__/edgeServer.mjs', import.meta.url));
  const edge = { command: process.execPath, args: [edgeFixture], approval: 'never' as const, stderr: 'capture' as const };
  const call = (mcp: McpConnections, name: string) => mcp.tools[name].tool.execute!({}, { toolCallId: 'c1', messages: [] });

  it("a server whose process exits reports 'failed' and logs a warning with the exit code", async () => {
    const logger = warnLogger();
    const mcp = await connect({ edge }, { logger });
    await call(mcp, 'edge__die');
    await vi.waitFor(() => expect(mcp.status()).toEqual({ edge: 'failed' }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/'edge'.*closed unexpectedly \(exit code 3\)[\s\S]*dying now/),
      expect.objectContaining({ exitCode: 3 })
    );
    // lazy (default): the next call reconnects.
    await expect(call(mcp, 'edge__page_two')).resolves.toMatchObject({ text: 'page_two' });
    expect(mcp.status()).toEqual({ edge: 'connected' });
  });

  it("createAgent offers a server's new tools on the next model call after tools/list_changed", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'edge__grow', args: {} }] }, 'grown', 'again', 'again', 'again']);
    const agent = createAgent({ provider: model, mcpServers: { edge } });
    closers.push(() => agent.close());
    await agent.send('grow');
    expect(model.calls[0].tools?.map((t) => t.function.name)).not.toContain('edge__grown');
    await vi.waitFor(async () => {
      await agent.send('again');
      expect(model.calls.at(-1)!.tools?.map((t) => t.function.name)).toContain('edge__grown');
    });
  });
});
