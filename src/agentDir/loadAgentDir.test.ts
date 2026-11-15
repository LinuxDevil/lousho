import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadAgentDir, resolveAgentDir } from './index';
import { mockModel } from '../testing';
import { explainImportError } from './importModule';
import { closest } from './closest';
import { SDKError } from '../utils/sdkError';
import type { CreateAgentBase } from '../createAgent';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);
const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);
const toolMessages = (call: { messages: readonly { role: string; content: unknown }[] }): string[] =>
  call.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('resolveAgentDir', () => {

  it('loads a .yaml config with inline instructions and no other files', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('yaml-inline'));
    expect(config.instructions).toBe('You are the YAML fixture agent.');
    expect(config.maxSteps).toBe(2);
    expect(config.tools).toBeUndefined();
    expect(config.skills).toBeUndefined();
    expect(manifest).toMatchObject({ tools: [], skills: [], subagents: [] });
    expect(manifest.files).toHaveLength(1);
  });
});

/**
 * Every `createAgent()` option, so a new one cannot be added
 * without this test noticing. `satisfies` fails to compile on a missing or an
 * unknown key.
 */
const CREATE_AGENT_OPTIONS = {
  tools: true, mcpServers: true, skills: true, harnessCanary: true, spanAttributes: true, name: true, description: true, subagents: true, subagentOptions: true,
  handoffs: true, maxHandoffs: true, toolSearch: true, codeMode: true, maxSubagentDepth: true, maxSteps: true, limits: true,
  guardrails: true, toolConcurrency: true, onAgentDrift: true, reasoning: true, modelSettings: true, onEvent: true, exporter: true,
  captureContent: true, redactContent: true, projectInstructions: true, store: true, approvalStore: true, approve: true,
  approvalTtlMs: true, askQuestion: true, retry: true, fallbackModels: true, output: true, hooks: true, compaction: true,
  memory: true, permissions: true, onPermissionDecision: true, permissionMode: true, onPermissionModeChange: true,
  maxToolResultChars: true, toolErrorMessage: true, promptCaching: true, rateLimit: true,
} satisfies Record<keyof CreateAgentBase, true>;

describe('createAgent() overrides', () => {
  it('forwards every createAgent() option to the assembled config', async () => {
    const keys = Object.keys(CREATE_AGENT_OPTIONS) as (keyof CreateAgentBase)[];
    // A distinct value per option (an array, since `skills` and `memory` are copied, not passed by reference).
    const overrides = Object.fromEntries(keys.map((key) => [key, [{ name: `override-${key}` }]]));
    const { config } = await resolveAgentDir(fixture('js-json'), { provider: mockModel(['x']), ...overrides } as never);

    const assembled = config as unknown as Record<string, unknown>;
    const dropped = keys.filter((key) => JSON.stringify(assembled[key]) !== JSON.stringify(overrides[key]));
    expect(dropped).toEqual([]);
  });
});

describe('loadAgentDir', () => {
  it('returns a working createAgent() agent whose disk tools and skills are callable', async () => {
    const model = mockModel([
      {
        toolCalls: [
          { name: 'echo', args: { text: 'hi' } },
          { name: 'add', args: { a: 2, b: 3 } },
          { name: 'load_skill', args: { name: 'release' } },
        ],
      },
      'All done.',
    ]);
    const agent = await loadAgentDir(fixture('full'), { provider: model });

    const result = await agent.send('go');

    expect(result.text).toBe('All done.');
    const first = model.calls[0];
    expect(systemOf(first)).toContain('You are the fixture agent.');
    expect(systemOf(first)).toContain('- changelog: How to write a changelog entry');
    expect(systemOf(first)).not.toContain('Bump the version');
    expect(first.tools?.map((t) => t.function.name).sort()).toEqual([
      'add',
      'agent_await',
      'agent_cancel',
      'agent_status',
      'delegate_to_researcher',
      'double',
      'echo',
      'load_skill',
      'read_skill_file',
      'task',
    ]);
    const outputs = toolMessages(model.calls[1]).join('\n');
    expect(outputs).toContain('echo: hi');
    expect(outputs).toContain('5');
    expect(outputs).toContain('Bump the version');
  });
});

describe('agent.* run options (permissionMode, permissions, compaction, hooks, approve, limits)', () => {
  it('maps every new key into the createAgent() options and tracks the files it imported', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('config-extras'), {
      provider: mockModel(['x']),
      model: 'openrouter/openai/gpt-4o-mini',
    });

    expect(config.permissionMode).toBe('default');
    expect(config.compaction).toEqual({ thresholdPercent: 0.8 });
    expect(config.limits).toEqual({ maxCostUsd: 0.05, onExceeded: 'stop' });
    expect(config.modelSettings).toEqual({ maxTokens: 2048, temperature: 0.2 });
    expect(config.retry).toEqual({ maxRetries: 4, timeoutMs: 30000, backoff: { initialMs: 1000 } });
    expect(config.permissions).toHaveLength(3);
    expect(config.permissions?.[0]).toMatchObject({ tool: 'shell', action: 'deny', reason: 'No deletes' });
    expect(typeof config.approve).toBe('function');
    expect(config.hooks?.map((hook) => hook.name)).toEqual(['spy']);
    const files = manifest.files.map((f) => path.relative(fixture('config-extras'), f).split(path.sep).join('/'));
    expect(files).toEqual(
      expect.arrayContaining(['agent.json', 'instructions.md', 'instructions/openai.md', 'hooks.ts', 'approve.ts', 'tools/stubs.ts'])
    );
  });

  it('approve: null / hooks: null strip the directory-wired approver and hooks (the files are not even imported)', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('config-extras'), {
      provider: mockModel(['x']),
      approve: null,
      hooks: null,
    });
    expect(config.approve).toBeUndefined();
    expect(config.hooks).toBeUndefined();
    const files = manifest.files.map((f) => path.relative(fixture('config-extras'), f).split(path.sep).join('/'));
    expect(files).not.toContain('approve.ts');
    expect(files).not.toContain('hooks.ts');
  });
});

describe('agent.* store and approval TTL (store, approvalTtlMs, ttlMs)', () => {
  /** A minimal agent directory in a temp dir (a fixture would litter its own .lousho/). */
  const writeDir = (config: Record<string, unknown>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-agentdir-store-'));
    writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(config));
    writeFileSync(path.join(dir, 'instructions.md'), 'You are a test agent.\n');
    return dir;
  };

  it('rejects a store.dir that escapes the agent directory, naming the key', async () => {
    const dir = writeDir({ model: 'mock/m', store: { dir: '../outside' } });
    try {
      const error = (await resolveAgentDir(dir, { provider: mockModel(['x']) }).catch((e: Error) => e)) as Error;
      expect(error.message).toContain('agent.json');
      expect(error.message).toContain("'store.dir'");
      expect(error.message).toContain('must stay inside the agent directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine: 'pi' sub-agent directories", () => {

  it('rejects engine on the main config, a bad engine value and a non-pi model id', async () => {
    const rootError = (await resolveAgentDir(fixture('err-engine-root')).catch((e: Error) => e)) as Error;
    expect(rootError.message).toContain(`'engine' is only valid for a directory under 'subagents/'`);

    const badError = (await resolveAgentDir(fixture('err-engine-bad')).catch((e: Error) => e)) as Error;
    expect(badError.message).toContain(path.join('subagents', 'coder', 'agent.json'));
    expect(badError.message).toContain("'engine' must be 'pi'");

    const modelError = (await resolveAgentDir(fixture('err-engine-model')).catch((e: Error) => e)) as Error;
    expect(modelError.message).toContain("'model' must be a 'pi/<provider>/<model>' id");
  });

  it('delegates through the installed dir: mock lead -> task -> pi session on a faux runtime', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-'));
    const agentDir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-pi-'));
    try {
      writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock/m' }));
      writeFileSync(path.join(dir, 'instructions.md'), 'You delegate code changes to the coder.\n');
      writeFileSync(path.join(dir, 'note.txt'), 'broken\n');
      mkdirSync(path.join(dir, 'subagents', 'coder'), { recursive: true });
      writeFileSync(
        path.join(dir, 'subagents', 'coder', 'agent.json'),
        JSON.stringify({
          description: 'Edits files with Pi tools.',
          engine: 'pi',
          model: 'pi/openrouter/openai/gpt-4o-mini',
          permissions: [
            { tool: 'bash', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No deletes' },
            { tool: '*', action: 'allow' },
          ],
        })
      );

      const runtime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsStorePath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      const faux = fauxProvider();
      runtime.registerNativeProvider(faux.provider);
      const piModel = runtime.getModel('faux', 'faux-1')!;
      const fixer: FauxResponseStep = (context) => {
        const last = context.messages.at(-1);
        if (last?.role === 'toolResult') return fauxAssistantMessage('Done.');
        return fauxAssistantMessage(
          fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'broken', newText: 'fixed' }] })
        );
      };
      faux.setResponses([fixer, fixer, fixer]);

      const agent = await loadAgentDir(dir, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Fix note.txt', description: 'fix note' } }] },
          { text: 'delegated' },
        ]),
        piAgent: { modelRuntime: runtime, model: piModel, agentDir, sessionDir: path.join(agentDir, 'sessions') },
      });

      const result = await agent.send('go');
      expect(result.text).toBe('delegated');
      expect(readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('fixed\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('applies the pi sub-agent config permissions to its tool calls', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-'));
    const agentDir = mkdtempSync(path.join(tmpdir(), 'lousho-pidir-pi-'));
    try {
      writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock/m' }));
      writeFileSync(path.join(dir, 'instructions.md'), 'lead\n');
      writeFileSync(path.join(dir, 'note.txt'), 'broken\n');
      mkdirSync(path.join(dir, 'subagents', 'coder'), { recursive: true });
      writeFileSync(
        path.join(dir, 'subagents', 'coder', 'agent.json'),
        JSON.stringify({
          description: 'Edits files with Pi tools.',
          engine: 'pi',
          permissions: [{ tool: 'edit', action: 'deny', reason: 'No edits' }],
        })
      );

      const runtime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsStorePath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      const faux = fauxProvider();
      runtime.registerNativeProvider(faux.provider);
      const piModel = runtime.getModel('faux', 'faux-1')!;
      faux.setResponses([
        (context) => {
          const last = context.messages.at(-1);
          if (last?.role === 'toolResult') return fauxAssistantMessage('The edit was refused.');
          return fauxAssistantMessage(fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'broken', newText: 'fixed' }] }));
        },
      ]);

      const agent = await loadAgentDir(dir, {
        provider: mockModel([
          { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'Fix note.txt', description: 'fix note' } }] },
          { text: 'delegated' },
        ]),
        piAgent: { modelRuntime: runtime, model: piModel, agentDir, sessionDir: path.join(agentDir, 'sessions') },
      });

      await agent.send('go');
      expect(readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('broken\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('validation errors', () => {

  it('says what a tools file exported, and shows a defineTool example', async () => {
    const file = path.join(fixture('err-bad-tool'), 'tools', 'nothing.ts');
    const error = (await resolveAgentDir(fixture('err-bad-tool')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain('default: object, helper: number');
    expect(error.message).toContain('defineTool({ name:');
  });

  it('suggests the right key for unknown config keys', async () => {
    const file = path.join(fixture('err-unknown-key'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-unknown-key')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain("'modle' (did you mean 'model'?)");
    expect(error.message).toContain("'prompt2'");
    expect(error.message).toContain('Allowed keys:');
  });

  it('rejects two config files, double instructions and invalid JSON, each naming the path', async () => {
    await expect(resolveAgentDir(fixture('err-two-configs'))).rejects.toThrow(
      /more than one config file \(agent\.json, agent\.yaml\)/
    );
    await expect(resolveAgentDir(fixture('err-double-instructions'))).rejects.toThrow(
      /instructions are given twice/
    );
    await expect(resolveAgentDir(fixture('err-bad-json'))).rejects.toThrow(
      new RegExp(`${path.join(fixture('err-bad-json'), 'agent.json').replace(/\\/g, '\\\\')}: invalid JSON`)
    );
  });

  it('fails a missing hooks file naming the config path it came from', async () => {
    const file = path.join(fixture('err-missing-hooks'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-missing-hooks')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain("'hooks'");
    expect(error.message).toContain('nope/hooks.ts');
  });
});

describe('helpers', () => {

  it('explains TypeScript syntax that type stripping cannot erase, without claiming TypeScript cannot load', () => {
    const cause = Object.assign(new Error('TypeScript enum is not supported in strip-only mode'), {
      code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
    });
    const message = explainImportError('/x/tools/a.ts', cause).message;
    expect(message).toContain('/x/tools/a.ts');
    expect(message).toContain('enum');
    expect(message).toContain('--experimental-transform-types');
    expect(message).not.toContain('cannot load TypeScript files');
    expect(message).not.toContain('your-script.ts');
  });

  it('codes an unresolvable package import with a hint naming the package and where Node looks for it', () => {
    const esm = Object.assign(new Error("Cannot find package 'lousho' imported from /k/tools/fs.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    const error = explainImportError('/k/tools/fs.ts', esm) as SDKError;
    expect(error).toBeInstanceOf(SDKError);
    expect(error.code).toBe('LOUSHO_AGENT_DIR_INVALID');
    expect(error.message).toContain('failed to import /k/tools/fs.ts');
    expect(error.hint).toContain('npm install lousho');
    expect(error.hint).toContain('node_modules');
    const cjs = Object.assign(new Error("Cannot find module 'zod/v4'\nRequire stack:\n- /k/a.ts"), { code: 'MODULE_NOT_FOUND' });
    expect((explainImportError('/k/a.ts', cjs) as SDKError).hint).toContain('npm install zod');
    // A missing relative file is not a package to install; it keeps the generic code and hint.
    const relative = Object.assign(new Error("Cannot find module './helpers'"), { code: 'MODULE_NOT_FOUND' });
    const plain = explainImportError('/k/a.ts', relative) as SDKError;
    expect(plain.code).toBe('LOUSHO_AGENT_DIR_INVALID');
    expect(plain.hint).not.toContain('npm install');
  });

  it('hints at the missing file extension of a relative import that type stripping cannot resolve', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-ext-hint-'));
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'lib', 'store.ts'), 'export {};');
    const hooks = path.join(dir, 'hooks.ts');
    const esm = Object.assign(new Error(`Cannot find module '${path.join(dir, 'lib', 'store')}' imported from ${hooks}`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const error = explainImportError(hooks, esm) as SDKError;
    expect(error.code).toBe('LOUSHO_AGENT_DIR_INVALID');
    expect(error.hint).toContain("write './lib/store.ts' instead of './lib/store'");
    const cjs = Object.assign(new Error("Cannot find module './lib/store'\nRequire stack:\n- x"), { code: 'MODULE_NOT_FOUND' });
    expect((explainImportError(hooks, cjs) as SDKError).hint).toContain("'./lib/store.ts'");
    // No such file with any extension: no extension hint.
    const gone = Object.assign(new Error("Cannot find module './lib/nope'"), { code: 'MODULE_NOT_FOUND' });
    expect((explainImportError(hooks, gone) as SDKError).hint ?? '').not.toContain('instead of');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the Node version when it has no built-in type stripping', () => {
    const cause = Object.assign(new Error('Unknown file extension ".ts"'), { code: 'ERR_UNKNOWN_FILE_EXTENSION' });
    const node = Object.getOwnPropertyDescriptor(process.versions, 'node');
    Object.defineProperty(process.versions, 'node', { value: '20.20.0', configurable: true });
    try {
      expect(explainImportError('/x/tools/a.ts', cause).message).toContain('needs Node 22.19 or newer (this is Node 20.20.0)');
    } finally {
      Object.defineProperty(process.versions, 'node', node as PropertyDescriptor);
    }
    expect(explainImportError('/x/tools/a.ts', cause).message).not.toContain('this is Node');
  });

  it('suggests close keys and nothing for distant ones', () => {
    expect(closest('maxStep', ['maxSteps', 'name'])).toBe('maxSteps');
    expect(closest('prompt', ['instructions', 'name'])).toBe('instructions');
    expect(closest('zzzzzzzz', ['maxSteps', 'name'])).toBeUndefined();
  });
});
