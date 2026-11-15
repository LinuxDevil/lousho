import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startDevServer, DevServerHandle } from './dev';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';
import { mockModel } from '../testing';
import { collectLocalImports, detectTarget } from './devReload';
import { z } from 'zod';
import { memoryStore } from '../storage/agentStore';
import { defineTool } from '../tools/defineTool';
import { parseEventStream } from '../react/parseEventStream';
import type { CreateAgentConfig } from '../createAgent';
import type { AgentEvent } from '../execution/agentEvents';

const MOCK_RESPONSE = 'This is the mock dev-server response.';

beforeAll(() => {
  LLMProviderRegistry.register('mock', () =>
    createMockProvider({ responses: [MOCK_RESPONSE] })
  );
});

function writeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const configPath = path.join(dir, 'agent.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: 'dev-test-agent',
      prompt: 'You are a helpful test agent.',
      provider: { type: 'mock', model: 'mock-model-1' },
      ...overrides,
    })
  );
  return configPath;
}

let handle: DevServerHandle | undefined;
afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

describe('startDevServer', () => {

  it('a realistic message round-trip via the UI page\'s own /chat call produces a reply', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);

    // Confirm the page itself posts { sessionId, input } to /chat (what its
    // inline script does), then drive that exact same call.
    const page = await (await fetch(`http://localhost:${port}/`)).text();
    expect(page).toContain("stream('/chat', { sessionId, input: text })");

    const res = await fetch(`http://localhost:${port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ui', input: 'hello from the UI' }),
    });
    expect(await res.text()).toContain(MOCK_RESPONSE);
  });

  it('refuses a foreign Host header (DNS rebinding), keeps /health open, and accepts --allowed-hosts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dev-'));
    handle = await startDevServer(writeConfig(dir), 0);
    const port = addressPort(handle);
    const status = (route: string, host: string, method = 'GET') =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host, 'content-type': 'application/json' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(method === 'POST' ? JSON.stringify({ sessionId: 'rebind', input: 'hi' }) : undefined);
      });
    expect(await status('/chat', `evil.example:${port}`, 'POST')).toBe(403);
    expect(await status('/chat/rebind', `127.attacker.example:${port}`)).toBe(403);
    expect(await status('/', `evil.example:${port}`)).toBe(403);
    expect(await status('/dev/status', `evil.example:${port}`)).toBe(403);
    expect(await status('/health', `evil.example:${port}`)).toBe(200);
    expect(await status('/dev/status', `localhost:${port}`)).toBe(200);
    expect(await status('/dev/status', `[::1]:${port}`)).toBe(200);
    await handle.close();

    handle = await startDevServer(writeConfig(dir), 0, '127.0.0.1', { allowedHosts: ['devbox.test'] });
    const allowedPort = addressPort(handle);
    const allowed = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: allowedPort, path: '/dev/status', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
    expect(await allowed(`devbox.test:${allowedPort}`)).toBe(200);
    expect(await allowed(`localhost:${allowedPort}`)).toBe(200);
    expect(await allowed(`evil.example:${allowedPort}`)).toBe(403);
  });

  it('--allowed-hosts adds to the defaults: off loopback, IP addresses are still served', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dev-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = await startDevServer(writeConfig(dir), 0, '0.0.0.0', { allowedHosts: ['devbox.test'] });
    const port = addressPort(handle);
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/dev/status', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
    expect(await status(`192.168.1.20:${port}`)).toBe(200);
    expect(await status(`devbox.test:${port}`)).toBe(200);
    expect(await status(`localhost:${port}`)).toBe(200);
    expect(await status(`evil.example:${port}`)).toBe(403);
    vi.restoreAllMocks();
  });

  it('rejects with a clear message when the port is already in use', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);

    await expect(startDevServer(configPath, port)).rejects.toThrow(
      new RegExp(`port ${port} is already in use`)
    );
  });
});

describe('hot reload', () => {
  it('picks up an edited prompt without restarting the server/port, and keeps working on an invalid edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-dev-reload-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);
    const originalServer = handle.server;

    const first = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      })
    ).json();
    expect(first.text).toBe(MOCK_RESPONSE);

    // Register a second mock provider variant so the reload is observable.
    const UPDATED_RESPONSE = 'Updated after hot reload.';
    LLMProviderRegistry.register('mock', () =>
      createMockProvider({ responses: [UPDATED_RESPONSE] })
    );

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: 'dev-test-agent',
        prompt: 'You are an UPDATED helpful test agent.',
        provider: { type: 'mock', model: 'mock-model-1' },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi again' }),
      })
    ).json();
    expect(second.text).toBe(UPDATED_RESPONSE);

    // Same server/port the whole time - no restart happened.
    expect(handle.server).toBe(originalServer);
    expect(addressPort(handle)).toBe(port);

    // Now write an invalid edit (missing required 'prompt') - the server
    // must keep serving the last-good (UPDATED_RESPONSE) config rather
    // than crashing.
    fs.writeFileSync(configPath, JSON.stringify({ provider: { type: 'mock', model: 'x' } }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const third = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'still there?' }),
      })
    ).json();
    expect(third.text).toBe(UPDATED_RESPONSE);
  });
});

describe('agent directories and TS modules', () => {
  const fixtures = path.join(__dirname, '__fixtures__');
  const copies: string[] = [];

  /** A scratch copy of a fixture next to it, so the fixture's relative imports still resolve. */
  function copyFixture(name: string): string {
    const copy = fs.mkdtempSync(path.join(fixtures, `tmp-${name}-`));
    copies.push(copy);
    fs.cpSync(path.join(fixtures, name), copy, { recursive: true });
    return copy;
  }
  afterEach(() => {
    for (const copy of copies.splice(0)) fs.rmSync(copy, { recursive: true, force: true });
  });

  const url = (h: DevServerHandle, route: string) => `http://localhost:${addressPort(h)}${route}`;
  const chat = async (h: DevServerHandle, message = 'hi') =>
    (
      await fetch(url(h, '/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    ).json();
  const status = async (h: DevServerHandle) => (await fetch(url(h, '/dev/status'))).json();
  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for the dev server');
  }
  const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }) =>
    String(call.messages.find((m) => m.role === 'system')?.content);

  it('detects a spec, a directory and a module by path type and extension, with coded errors otherwise', () => {
    expect(detectTarget(path.join(fixtures, 'dev-agent')).kind).toBe('dir');
    expect(detectTarget(path.join(fixtures, 'dev-module', 'agent.ts')).kind).toBe('module');
    expect(detectTarget('agent.yaml').kind).toBe('spec');
    expect(() => detectTarget(path.join(fixtures, 'nope.ts'))).toThrow(/LOUSHO_CONFIG_INVALID/);
    expect(() => detectTarget(path.join(fixtures, 'dev-agent', 'instructions.md'))).toThrow(
      /LOUSHO_SPEC_UNSUPPORTED_FORMAT/
    );
  });

  it('serves a TS module whose default export is a SimpleAgent, and accepts a config export', async () => {
    handle = await startDevServer(path.join(fixtures, 'dev-module', 'agent.ts'), 0);
    expect((await chat(handle)).text).toBe('module says hi');
    expect(await status(handle)).toMatchObject({ kind: 'module' });
    await handle.close();

    const provider = mockModel(['config says hi']);
    handle = await startDevServer(path.join(fixtures, 'dev-module', 'config.ts'), 0, '127.0.0.1', {
      overrides: { provider },
    });
    expect((await chat(handle)).text).toBe('config says hi');
    expect(systemOf(provider.calls[0])).toContain('config-export agent');
  });

  it('reloads an edited CommonJS tool file, and reports a broken one instead of keeping the cached copy', async () => {
    const dir = copyFixture('dev-agent');
    const cjsTool = path.join(dir, 'tools', 'pong.cjs');
    const helper = path.join(dir, 'tools', 'helpers', 'name.cjs');
    fs.mkdirSync(path.dirname(helper));
    fs.writeFileSync(helper, "module.exports = 'pong';\n");
    // Plain `require` cannot load the SDK's TypeScript source, so the tool file gets defineTool from the test.
    (globalThis as Record<string, unknown>).__loushoDevTestDefineTool = defineTool;
    const source = (name: string) =>
      "const { z } = require('zod');\nconst defineTool = globalThis.__loushoDevTestDefineTool;\n" +
      `module.exports = defineTool({ name: ${name}, description: 'Pong', input: z.object({}), execute: () => 'ping' });\n`;
    fs.writeFileSync(cjsTool, source("require('./helpers/name.cjs')"));
    const provider = mockModel(['ok', 'ok', 'ok', 'ok']);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider }, debounceMs: 20 });
    await chat(handle);
    expect(provider.calls[0].tools?.map((t) => t.function.name).sort()).toEqual(['ping', 'pong']);

    fs.writeFileSync(cjsTool, source("'pong_v2'"));
    await waitFor(async () => (await status(handle!)).reloads >= 1);
    await chat(handle);
    expect(provider.calls[1].tools?.map((t) => t.function.name).sort()).toEqual(['ping', 'pong_v2']);

    // A required CommonJS helper is re-read too.
    fs.writeFileSync(cjsTool, source("require('./helpers/name.cjs')"));
    await waitFor(async () => (await status(handle!)).reloads >= 2);
    fs.writeFileSync(helper, "module.exports = 'pong_v3';\n");
    await waitFor(async () => (await status(handle!)).reloads >= 3);
    await chat(handle);
    expect(provider.calls[2].tools?.map((t) => t.function.name).sort()).toEqual(['ping', 'pong_v3']);

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.appendFileSync(cjsTool, 'module.exports = (;\n');
    await waitFor(async () => (await status(handle!)).error !== null);
    expect((await status(handle)).reloads).toBe(3);
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining('keeping the previous agent'));
    quiet.mockRestore();
    delete (globalThis as Record<string, unknown>).__loushoDevTestDefineTool;
  });

  it('keeps watching a folder that is deleted and created again, and logs only real paths', async () => {
    const dir = copyFixture('dev-agent');
    const tools = path.join(dir, 'tools');
    const toolFile = path.join(tools, 'ping.ts');
    const original = fs.readFileSync(toolFile, 'utf8');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = mockModel(['ok', 'ok']);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider }, debounceMs: 20 });
    const settle = async () => {
      // Let the watchers deliver every event, so the next step starts from a quiet tree.
      let reloads = -1;
      while (reloads !== (await status(handle!)).reloads) {
        reloads = (await status(handle!)).reloads;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return reloads;
    };

    // What `git checkout` of a branch without the folder, then back, does.
    fs.rmSync(tools, { recursive: true });
    await settle();
    fs.mkdirSync(tools);
    fs.writeFileSync(toolFile, original);
    let before = await settle();

    for (const name of ['ping_a', 'ping_b']) {
      fs.writeFileSync(toolFile, original.replace("'ping'", `'${name}'`));
      await waitFor(async () => (await status(handle!)).reloads > before);
      before = await settle();
    }
    await chat(handle);
    expect(provider.calls[0].tools?.map((t) => t.function.name)).toEqual(['ping_b']);

    // A file added to the recreated folder is picked up too.
    fs.writeFileSync(path.join(tools, 'pong.ts'), original.replace("'ping'", "'pong'"));
    await waitFor(async () => (await status(handle!)).reloads > before);
    await settle();
    await chat(handle);
    expect(provider.calls[1].tools?.map((t) => t.function.name).sort()).toEqual(['ping_b', 'pong']);

    const changed = logs.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('changed:'));
    expect(changed.join('\n')).not.toMatch(/tools[\\/]tools/);
    logs.mockRestore();
  });

  it('reloads a module when it or a local import changes', async () => {
    const dir = copyFixture('dev-module');
    const file = path.join(dir, 'agent.ts');
    const local = collectLocalImports(file).filter((f) => f.startsWith(dir));
    expect(local.map((f) => path.basename(f)).sort()).toEqual(['agent.ts', 'greeting.ts']);

    handle = await startDevServer(file, 0, '127.0.0.1', { debounceMs: 20 });
    expect((await chat(handle)).text).toBe('module says hi');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('module says hi', 'edited reply'));
    await waitFor(async () => (await status(handle!)).reloads >= 1);
    expect((await chat(handle)).text).toBe('edited reply');

    // An edit to an imported file triggers a reload too.
    fs.appendFileSync(path.join(dir, 'greeting.ts'), '// touched\n');
    await waitFor(async () => (await status(handle!)).reloads >= 2);
  });
});

describe('stateful streaming chat', () => {
  const fixtures = path.join(__dirname, '__fixtures__');
  const post = (h: DevServerHandle, route: string, body: unknown) =>
    fetch(`http://localhost:${addressPort(h)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const eventsOf = async (res: Response): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of parseEventStream(res)) events.push(event);
    return events;
  };
  const turn = async (h: DevServerHandle, sessionId: string, input: string) => eventsOf(await post(h, '/chat', { sessionId, input }));
  const ping = defineTool({ name: 'ping', description: 'Reply with pong', input: z.object({}), execute: () => 'pong', needsApproval: true });
  const serve = (provider: ReturnType<typeof mockModel>, extra: CreateAgentConfig = {}) =>
    startDevServer(path.join(fixtures, 'dev-module', 'config.ts'), 0, '127.0.0.1', { overrides: { provider, tools: [ping], ...extra } });
  const pinged = { toolCalls: [{ name: 'ping' }] };

  it("uses the agent's own store when it has one", async () => {
    const store = memoryStore();
    handle = await serve(mockModel(['stored']), { store });
    await turn(handle, 'own', 'hi');
    expect((await store.sessions.load('own'))?.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('rejects an approval with a note, and answers a question', async () => {
    const provider = mockModel([
      pinged,
      'Understood, not pinging.',
      { toolCalls: [{ name: 'ask_question', args: { question: 'Where to?', options: ['Porto', 'Lisbon'] } }] },
      'Lisbon it is.',
    ]);
    handle = await serve(provider, { askQuestion: true });

    const first = await turn(handle, 's3', 'ping it');
    const rejected = await eventsOf(
      await post(handle, `/chat/s3/approvals/${(first.find((e) => e.type === 'approval.requested') as { approvalId: string }).approvalId}`, {
        approved: false,
        note: 'Not now',
      })
    );
    expect(rejected.at(-1)).toMatchObject({ finishReason: 'stop', text: 'Understood, not pinging.' });
    expect(JSON.stringify(provider.calls[1].messages)).toContain('Not now');

    const asked = await turn(handle, 's3', 'plan a trip');
    const question = asked.find((e) => e.type === 'approval.requested');
    expect(question).toMatchObject({ kind: 'question', question: { text: 'Where to?', options: ['Porto', 'Lisbon'] } });
    const answered = await eventsOf(await post(handle, `/chat/s3/approvals/${(question as { approvalId: string }).approvalId}`, { answer: 'Lisbon' }));
    expect(answered.find((e) => e.type === 'tool.done')).toMatchObject({ toolName: 'ask_question', result: { answer: 'Lisbon', option: 1 } });
    expect(answered.at(-1)).toMatchObject({ finishReason: 'stop', text: 'Lisbon it is.' });

    expect((await post(handle, '/chat/s3/approvals/nope', {})).status).toBe(400);
  });
});

function addressPort(h: DevServerHandle): number {
  const addr = h.server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return h.port;
}
