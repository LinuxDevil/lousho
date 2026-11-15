import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpArgs, runMcp, startMcpServer } from './mcp';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';

beforeAll(() => {
  LLMProviderRegistry.register('mock', () => createMockProvider({ responses: ['hello'] }));
});

describe('parseMcpArgs', () => {

  it('explains how to fix a missing path or bad port', () => {
    expect(() => parseMcpArgs([])).toThrow(/an agent path is required \(a spec file, an agent directory or a \.ts\/\.js module\)/);
    expect(() => parseMcpArgs(['a.json', '--http', '--port', 'abc'])).toThrow(/--port must be an integer/);
    // stdio has no port: a --port without --http is a usage error, not silently ignored.
    expect(() => parseMcpArgs(['a.json', '--port', '5'])).toThrow(/--port and --host need --http/);
  });
});

describe('lousho mcp with an agent directory', () => {
  it('serves an agent directory instead of crashing with EISDIR', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-mcp-dir-'));
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'openai/gpt-4o-mini' }));
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'Be brief.');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const server = await startMcpServer({ configPath: dir, http: true, port: 0, host: '127.0.0.1' });
    try {
      expect(server.url).toMatch(/\/mcp$/);
      expect(server.agentToolName).toBe(path.basename(dir).replace(/[^A-Za-z0-9_-]/g, '_'));
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it('prefixes failures with the command and never leaks a raw fs error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-mcp-empty-'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMcp([dir, '--http', '--port', '0'])).toBe(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toMatch(/^lousho mcp:|LOUSHO_/);
    expect(message).not.toMatch(/EISDIR/);
    error.mockRestore();
  });
});
