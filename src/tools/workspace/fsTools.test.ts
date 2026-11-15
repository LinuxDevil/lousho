import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import type { DefinedTool } from '../defineTool';
import { createFsTools, type FsToolsOptions } from './fsTools';
import { MemoryWorkspace } from './MemoryWorkspace';
import { WorkspaceCheckpoints } from './checkpoints';
import type { FsProvider } from './types';
import { grepFiles } from './fsOperations';

function toolsByName(fs: FsProvider, options?: FsToolsOptions): Record<string, DefinedTool> {
  return Object.fromEntries(createFsTools(fs, options).map((t) => [t.name, t]));
}

/** Calls a tool's execute directly (no agent loop). */
function call(tool: DefinedTool, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
  // ai's Tool.execute returns PromiseLike; wrap it so callers get a real Promise.
  return Promise.resolve(tool.tool.execute!(args, { toolCallId: 't', messages: [], abortSignal }));
}

describe('createFsTools on MemoryWorkspace', () => {

  describe('read_file', () => {

    it('caps lines and characters', async () => {
      const content = Array.from({ length: 50 }, () => 'x'.repeat(100)).join('\n');
      const tools = toolsByName(new MemoryWorkspace({ files: { 'a.txt': content, 'long.txt': 'y'.repeat(5000) } }), {
        maxReadLines: 20,
        maxOutputChars: 500,
      });
      const out = (await call(tools.read_file, { path: 'a.txt' })) as string;
      expect(out).toMatch(/\[Truncated: showing lines 1-4 of 50\. Call read_file with offset=5/);
      expect(out.length).toBeLessThan(700);
      const long = (await call(tools.read_file, { path: 'long.txt' })) as string;
      expect(long).toContain('[line truncated]');
    });

    it('refuses files too large to load, and grep skips them', async () => {
      const ws = new MemoryWorkspace({ files: { 'huge.log': 'x'.repeat(10_000_001), 'small.log': 'x' } });
      const tools = toolsByName(ws);
      await expect(call(tools.read_file, { path: 'huge.log' })).rejects.toThrow(/huge\.log is too large to read \(10000001 bytes\)/);
      expect(await call(tools.grep, { pattern: 'x' })).toBe('small.log:1: x');
    });

    it('reports empty, binary, missing and directory paths', async () => {
      const { read_file } = toolsByName(new MemoryWorkspace({ files: { 'e.txt': '', 'b.bin': 'a\0b', 'd/x': '' } }));
      expect(await call(read_file, { path: 'e.txt' })).toBe('e.txt is empty.');
      expect(await call(read_file, { path: 'b.bin' })).toMatch(/binary file/);
      await expect(call(read_file, { path: 'nope.txt' })).rejects.toThrow('File not found: nope.txt');
      await expect(call(read_file, { path: 'd' })).rejects.toThrow('d is a directory, not a file.');
    });
  });

  describe('edit_file', () => {

    it('refuses a non-unique old_string unless replace_all', async () => {
      const ws = new MemoryWorkspace({ files: { 'a.ts': 'x x x' } });
      const { edit_file } = toolsByName(ws);
      await expect(call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'y' })).rejects.toThrow(
        'old_string appears 3 times in a.ts. Include more surrounding lines to make it unique, or pass replace_all: true to replace every occurrence.'
      );
      expect(ws.snapshot()['a.ts']).toBe('x x x');
      expect(await call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })).toBe(
        'Edited a.ts: replaced 3 occurrences.'
      );
      expect(ws.snapshot()['a.ts']).toBe('y y y');
    });

    it('explains a missing old_string, with a CRLF hint when relevant', async () => {
      const { edit_file } = toolsByName(new MemoryWorkspace({ files: { 'a.ts': 'one\r\ntwo\r\n' } }));
      await expect(call(edit_file, { path: 'a.ts', old_string: 'three', new_string: 'x' })).rejects.toThrow(
        /old_string was not found in a.ts\. Call read_file and copy the exact text/
      );
      await expect(call(edit_file, { path: 'a.ts', old_string: 'one\ntwo', new_string: 'x' })).rejects.toThrow(/CRLF line endings/);
    });

    it('rejects empty and no-op edits', async () => {
      const { edit_file } = toolsByName(new MemoryWorkspace({ files: { 'a.ts': 'x' } }));
      await expect(call(edit_file, { path: 'a.ts', old_string: '', new_string: 'y' })).rejects.toThrow(/use write_file/);
      await expect(call(edit_file, { path: 'a.ts', old_string: 'x', new_string: 'x' })).rejects.toThrow(/identical/);
    });
  });

  it('list_dir sorts entries, marks directories and caps the list', async () => {
    const ws = new MemoryWorkspace({ files: { 'b.txt': '', 'a/x.txt': '', 'c.txt': '' } });
    expect(await call(toolsByName(ws).list_dir, {})).toBe('a/\nb.txt\nc.txt');
    expect(await call(toolsByName(ws, { maxResults: 2 }).list_dir, {})).toBe('a/\nb.txt\n[Truncated: showing 2 of 3 entries.]');
    await ws.mkdir('empty');
    expect(await call(toolsByName(ws).list_dir, { path: 'empty' })).toBe('empty is empty.');
    await expect(call(toolsByName(ws).list_dir, { path: 'b.txt' })).rejects.toThrow('b.txt is a file, not a directory.');
  });

  describe('glob', () => {
    const files = {
      'src/a.ts': '',
      'src/b.js': '',
      'src/deep/c.ts': '',
      'README.md': '',
      'node_modules/pkg/index.ts': '',
      '.git/config.ts': '',
    };

    it('returns sorted matches and skips ignored directories', async () => {
      const { glob } = toolsByName(new MemoryWorkspace({ files }));
      expect(await call(glob, { pattern: '**/*.ts' })).toBe('src/a.ts\nsrc/deep/c.ts');
      expect(await call(glob, { pattern: '*.ts', path: 'src' })).toBe('src/a.ts');
      expect(await call(glob, { pattern: '*.md' })).toBe('README.md');
      expect(await call(glob, { pattern: '*.py' })).toBe('No files match "*.py" under ..');
    });

    it('caps results and the number of files scanned', async () => {
      const ws = new MemoryWorkspace({ files });
      expect(await call(toolsByName(ws, { maxResults: 1 }).glob, { pattern: '**' })).toMatch(/^README\.md\n\[Truncated: showing 1 of 4 matches\.\]$/);
      expect(await call(toolsByName(ws, { maxFilesScanned: 1 }).glob, { pattern: '**' })).toMatch(/Stopped after scanning 1 files/);
      expect(await call(toolsByName(ws, { ignore: [] }).glob, { pattern: '**/index.ts' })).toBe('node_modules/pkg/index.ts');
    });

    it('rejects patterns and paths that escape the workspace', async () => {
      const { glob } = toolsByName(new MemoryWorkspace({ files }));
      await expect(call(glob, { pattern: '../**' })).rejects.toThrow(/outside the workspace/);
      await expect(call(glob, { pattern: '*', path: '/etc' })).rejects.toThrow(/outside the workspace/);
    });
  });

  describe('grep', () => {
    const files = {
      'src/a.ts': 'export function main() {}\nconst x = 1;\n',
      'src/b.js': 'function helper() {}\n',
      'docs/readme.md': 'Function docs\n',
      'bin.dat': 'function\0binary',
    };

    it('returns path:line: text for matches, honoring glob and ignore_case', async () => {
      const { grep } = toolsByName(new MemoryWorkspace({ files }));
      expect(await call(grep, { pattern: 'function \\w+' })).toBe('src/a.ts:1: export function main() {}\nsrc/b.js:1: function helper() {}');
      expect(await call(grep, { pattern: 'function', glob: '**/*.ts' })).toBe('src/a.ts:1: export function main() {}');
      expect(await call(grep, { pattern: '^function', ignore_case: true, path: 'docs' })).toBe('docs/readme.md:1: Function docs');
      expect(await call(grep, { pattern: 'const', path: 'src/a.ts' })).toBe('src/a.ts:2: const x = 1;');
      expect(await call(grep, { pattern: 'nothing-here' })).toBe('No matches for "nothing-here".');
    });

    it('caps matches and long lines', async () => {
      const ws = new MemoryWorkspace({ files: { 'a.txt': 'hit\n'.repeat(10), 'b.txt': `hit ${'z'.repeat(1000)}` } });
      expect(await call(toolsByName(ws, { maxResults: 3 }).grep, { pattern: 'hit' })).toBe(
        'a.txt:1: hit\na.txt:2: hit\na.txt:3: hit\n[Truncated at 3 matches; narrow the pattern, path or glob.]'
      );
      expect(await call(toolsByName(ws).grep, { pattern: 'z', path: 'b.txt' })).toMatch(/\[line truncated\]$/);
    });

    it('turns an invalid regex or missing path into a clean error', async () => {
      const { grep } = toolsByName(new MemoryWorkspace({ files }));
      await expect(call(grep, { pattern: 'foo(' })).rejects.toThrow(/Invalid regular expression "foo\(":/);
      await expect(call(grep, { pattern: 'x', path: 'missing' })).rejects.toThrow('Path not found: missing');
    });

    // A model-written regex must not freeze the process.
    it('refuses a pattern with nested unbounded quantifiers, and allows the safe look-alikes', async () => {
      const { grep } = toolsByName(new MemoryWorkspace({ files: { 'data.txt': `${'a'.repeat(28)}!\n` } }));
      for (const pattern of ['^(a+)+$', '(\\w+\\s*)*', '((ab)*c)+', '(a|b+){2,}']) {
        await expect(call(grep, { pattern }), pattern).rejects.toThrow(/repeats a group that already repeats/);
      }
      for (const pattern of ['(a+)?!', '(ab)+', '[(a+)]+', '\\(a+\\)+', 'a+!', '(a{2})+']) {
        await expect(call(grep, { pattern }), pattern).resolves.toMatch(/^data\.txt:1:|No matches/);
      }
    });

    it('stops a slow pattern at the timeout without blocking the event loop', async () => {
      const ws = new MemoryWorkspace({ files: { 'spaces.txt': `${' '.repeat(3000)}\n` } });
      const limits = { maxReadLines: 2000, maxOutputChars: 30_000, maxResults: 100, maxFilesScanned: 10, ignore: new Set<string>(), grepTimeoutMs: 300 };
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const started = Date.now();
      // Polynomial (not nested) backtracking: far too slow on 2000 tested characters.
      await expect(grepFiles(ws, { pattern: '\\s*\\s*\\s*\\s*\\s*!' }, limits)).rejects.toThrow(/too slow on this input.*scanned 0 of 1 files/);
      clearInterval(timer);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(ticks).toBeGreaterThan(5);
    });

    it('an abort stops a running slow pattern at once', async () => {
      const ws = new MemoryWorkspace({ files: { 'spaces.txt': `${' '.repeat(3000)}\n` } });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      await expect(call(toolsByName(ws).grep, { pattern: '\\s*\\s*\\s*\\s*\\s*!' }, controller.signal)).rejects.toThrow(/cancelled/);
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});

describe('MemoryWorkspace', () => {
  it('stats, removes and refuses invalid operations', async () => {
    const ws = new MemoryWorkspace({ files: { 'd/a.txt': 'abc' } });
    expect(await ws.stat('d/a.txt')).toEqual({ type: 'file', size: 3 });
    expect(await ws.stat('d')).toEqual({ type: 'directory', size: 0 });
    expect(await ws.stat('nope')).toBeUndefined();
    await expect(ws.rm('d')).rejects.toThrow(/not empty; pass \{ recursive: true \}/);
    await expect(ws.rm('.')).rejects.toThrow(/workspace root/);
    await expect(ws.rm('nope')).rejects.toThrow('Not found: nope');
    await expect(ws.writeFile('d', 'x')).rejects.toThrow('d is a directory, not a file.');
    await expect(ws.mkdir('d/a.txt')).rejects.toThrow('d/a.txt is a file, not a directory.');
    await expect(ws.writeFile('d/a.txt/b', 'x')).rejects.toThrow('d/a.txt is a file, not a directory.');
    await expect(ws.writeFile('.', 'x')).rejects.toThrow('. is a directory, not a file.');
    expect(() => new MemoryWorkspace({ files: { './': 'x' } })).toThrow(/workspace root/);
    await expect(ws.readdir('nope')).rejects.toThrow('Directory not found: nope');
    await ws.rm('d', { recursive: true });
    expect(await ws.stat('d')).toBeUndefined();
    await ws.mkdir('e');
    await ws.rm('e');
    await ws.writeFile('f.txt', 'x');
    await ws.rm('f.txt');
    expect(ws.snapshot()).toEqual({});
  });
});

describe('createFsTools deny list (consumer harness H1-2)', () => {
  const token = 'AUTHORIZATION: basic c2VjcmV0';
  const files = {
    '.git/config': `[http "https://github.com/"]\n\textraheader = ${token}\n`,
    '.git/HEAD': 'ref: refs/heads/main\n',
    'sub/.git': 'gitdir: C:/Users/someone/repo/.git/worktrees/sub\n',
    'src/a.ts': 'export const a = 1;\n',
  };

  it.each(['.git/config', './.git/config', 'a/../.git/config', '.git\\config', '.GIT/config', '.git./config', '.git /HEAD', 'sub/.git', '.git', '.git/', './.git/'])(
    'read_file and list_dir refuse %j',
    async (path) => {
      const { read_file, list_dir } = toolsByName(new MemoryWorkspace({ files }), { readOnly: true });
      await expect(call(read_file, { path })).rejects.toThrow(/is denied: the file tools never open/);
      await expect(call(list_dir, { path })).rejects.toThrow(/is denied/);
    }
  );

  it('grep and glob refuse a denied path and never return denied entries, even with ignore: []', async () => {
    const { grep, glob, list_dir } = toolsByName(new MemoryWorkspace({ files }), { readOnly: true, ignore: [] });
    await expect(call(grep, { pattern: 'AUTHORIZATION', path: '.git/config' })).rejects.toThrow(/is denied/);
    await expect(call(grep, { pattern: 'x', path: './.git' })).rejects.toThrow(/is denied/);
    await expect(call(glob, { pattern: '*', path: '.git' })).rejects.toThrow(/is denied/);
    expect(await call(grep, { pattern: 'AUTHORIZATION|gitdir' })).toMatch(/^No matches/);
    expect(await call(glob, { pattern: '**' })).toBe('src/a.ts');
    expect(await call(list_dir, {})).toBe('src/\nsub/');
    expect(await call(list_dir, { path: 'sub' })).toBe('sub is empty.');
  });

  it('filters a provider-native glob too', async () => {
    const native: FsProvider = Object.assign(Object.create(new MemoryWorkspace({ files })) as MemoryWorkspace, {
      glob: async () => ['.git/config', 'sub/.git', 'src/a.ts'],
    });
    const { glob, grep } = toolsByName(native, { readOnly: true });
    expect(await call(glob, { pattern: '**' })).toBe('src/a.ts');
    expect(await call(grep, { pattern: 'AUTHORIZATION', glob: '**' })).toMatch(/^No matches/);
  });

  it('write_file and edit_file refuse denied paths, with and without checkpoints', async () => {
    for (const options of [{}, { checkpoints: new WorkspaceCheckpoints(new MemoryWorkspace()) }] as FsToolsOptions[]) {
      const ws = new MemoryWorkspace({ files });
      const { write_file, edit_file } = toolsByName(ws, options);
      await expect(call(write_file, { path: '.git/hooks/pre-commit', content: 'curl evil' })).rejects.toThrow(/is denied/);
      await expect(call(edit_file, { path: '.git/config', old_string: 'basic', new_string: 'x' })).rejects.toThrow(/is denied/);
      expect(ws.snapshot()['.git/config']).toContain(token);
      expect(ws.snapshot()['.git/hooks/pre-commit']).toBeUndefined();
    }
  });

  it('reaches the model as a WorkspaceError tool error, without the file content', async () => {
    const provider = mockModel([{ toolCalls: [{ name: 'read_file', args: { path: '.git/config' } }] }, 'ok']);
    await createAgent({ prompt: 'p', provider, tools: createFsTools(new MemoryWorkspace({ files }), { readOnly: true }) }).send('go');
    const toolMessage = provider.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage?.isError).toBe(true);
    expect(JSON.parse(toolMessage!.content as string)).toMatchObject({ error: 'WorkspaceError', toolName: 'read_file' });
    expect(toolMessage!.content).not.toContain('c2VjcmV0');
  });

  it('is configurable: custom names, and [] allows everything', async () => {
    const custom = toolsByName(new MemoryWorkspace({ files: { ...files, 'secrets/key': 'k' } }), { deny: ['secrets'] });
    await expect(call(custom.read_file, { path: 'Secrets/key' })).rejects.toThrow(/is denied/);
    expect(await call(custom.read_file, { path: '.git/HEAD' })).toContain('refs/heads/main');
    const open = toolsByName(new MemoryWorkspace({ files }), { deny: [] });
    expect(await call(open.read_file, { path: '.git/config' })).toContain(token);
    expect(() => createFsTools(new MemoryWorkspace(), { deny: ['.git/config'] })).toThrow(/entry names such as ".git", not paths/);
  });

  it.each(['.env', 'sub/.env', '.env.local', '.env.production', 'pkg/.env.staging', '.ENV', 'sub/.Env.Local', '.env.'])(
    'read_file refuses %j by default',
    async (path) => {
      const ws = new MemoryWorkspace({ files: { '.env': 'K=1', 'sub/.env': 'K=1', '.env.local': 'K=1', '.env.production': 'K=1', 'pkg/.env.staging': 'K=1' } });
      const { read_file } = toolsByName(ws, { readOnly: true });
      await expect(call(read_file, { path })).rejects.toThrow(/is denied: the file tools never open/);
    }
  );

  it('leaves .env.example, .env.sample and .env.template readable, and hides .env from glob and list_dir', async () => {
    const ws = new MemoryWorkspace({ files: { '.env': 'SECRET=1', '.env.local': 'SECRET=1', '.env.example': 'KEY=', '.env.sample': 'KEY=', 'sub/.env.template': 'KEY=', '.environment': 'x' } });
    const { read_file, list_dir } = toolsByName(ws, { readOnly: true });
    for (const path of ['.env.example', '.env.sample', 'sub/.env.template', '.environment']) {
      expect(await call(read_file, { path })).toBeDefined();
    }
    const listing = String(await call(list_dir, { path: '.' }));
    expect(listing).toContain('.env.example');
    expect(listing).not.toMatch(/\.env(\.local)?(?!\.)/);
  });

  it('a custom deny replaces the defaults, so .env is readable unless listed', async () => {
    const ws = new MemoryWorkspace({ files: { '.env': 'K=1', '.env.local': 'K=2' } });
    const open = toolsByName(ws, { deny: ['.git'] });
    expect(await call(open.read_file, { path: '.env' })).toContain('K=1');
    const wild = toolsByName(ws, { deny: ['.env.*'] });
    await expect(call(wild.read_file, { path: '.env.local' })).rejects.toThrow(/is denied/);
    expect(await call(wild.read_file, { path: '.env' })).toContain('K=1');
  });

  it('allows names that only contain a denied name', async () => {
    const ws = new MemoryWorkspace({ files: { '.gitignore': 'dist\n', '.github/ci.yml': 'on: push\n', 'my.git/x': 'y\n' } });
    const { read_file } = toolsByName(ws);
    expect(await call(read_file, { path: '.gitignore' })).toContain('dist');
    expect(await call(read_file, { path: '.github/ci.yml' })).toContain('push');
    expect(await call(read_file, { path: 'my.git/x' })).toContain('y');
  });
});
