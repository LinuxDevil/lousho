import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { folderSource } from './folderSource';
import { memorySource } from './memorySource';
import { applyChanges, revisionId } from './revision';
import type { RevisionMeta, WorkspaceChanges } from './types';
import { CONTRACT_FILES, sourceContract } from './__fixtures__/sourceContract';

function plantJournal(dir: string, changes: WorkspaceChanges): RevisionMeta {
  const base = new Map(Object.entries(CONTRACT_FILES));
  const meta: RevisionMeta = { seq: 1, revision: revisionId(applyChanges(base, changes)), parent: revisionId(base), createdAt: new Date(0).toISOString(), by: 'person:ann', message: 'crashed', kind: 'authoring' };
  mkdirSync(join(dir, '.lousho', 'revisions'), { recursive: true });
  writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes }));
  return meta;
}

describe('folderSource after a crash', () => {
  it('finishes a write whose journal was committed, on next access', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const meta = plantJournal(dir, { 'a.md': 'new', 'workspace.json': '{}', 'pages-old/x.md': null });
    writeFileSync(join(dir, 'a.md'), 'new');
    const source = folderSource(dir);
    expect(await source.revision()).toBe(meta.revision);
    expect(await source.read('workspace.json')).toBe('{}');
    expect(await source.read('pages-old/x.md')).toBeUndefined();
    expect(await source.history()).toEqual([meta]);
    expect(existsSync(join(dir, '.lousho', 'revisions', 'pending.json'))).toBe(false);
  });

  it('sets aside a journal that names a path outside the folder, fails that call once, then works', async () => {
    const outside = tempDir();
    const dir = folderWith(CONTRACT_FILES);
    const meta = plantJournal(dir, { 'a.md': 'x' });
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { [`../${outside.split('/').pop()}/planted.md`]: 'x' } }));
    const source = folderSource(dir);
    expect(await codeOf(source.revision())).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    expect(readdirSync(outside)).toEqual([]);
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
    expect(readdirSync(join(dir, '.lousho', 'revisions')).some((name) => name.startsWith('pending.failed-'))).toBe(true);
  });

  it('sets aside a malformed journal and puts back the files it named from the parent snapshot', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const source = folderSource(dir);
    const base = await source.revision();
    await source.write!({ 'a.md': '1' }, { expectedRevision: base, by: 'person:ann', message: 'one' });
    const meta = { seq: 2, revision: 'a'.repeat(64), parent: base, createdAt: 'x', by: 'person:ann', message: 'bad', kind: 'authoring' };
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { 'a.md': 'half', 'b/c.md': 7 } }));
    expect(await codeOf(source.read('a.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { 'workspace.json': 'half', 'a.md/x': 'y' } }));
    writeFileSync(join(dir, 'workspace.json'), 'half');
    expect(await codeOf(source.read('a.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    expect(await source.read('workspace.json')).toBe(CONTRACT_FILES['workspace.json']);
    expect((await source.history()).map((entry) => entry.seq)).toEqual([1]);
  });
});
const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-source-'));
  made.push(dir);
  return dir;
}

function folderWith(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

sourceContract('folderSource', async (files) => folderSource(folderWith(files)));

describe('folderSource', () => {

  it('keeps snapshots for the last `keep` revisions only', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES), { keep: 2 });
    const base = await source.revision();
    let expectedRevision = base;
    const metas = [];
    for (const n of [1, 2, 3]) {
      const meta = await source.write!({ 'a.md': String(n) }, { expectedRevision, by: 'person:ann', message: `${n}` });
      metas.push(meta);
      expectedRevision = meta.revision;
    }
    expect(await source.read('a.md', { revision: base })).toBeUndefined();
    expect(await codeOf(source.read('a.md', { revision: metas[0].revision }))).toBe('LOUSHO_WORKSPACE_REVISION_UNKNOWN');
    expect(await source.read('a.md', { revision: metas[1].revision })).toBe('2');
    expect(await source.history()).toHaveLength(3);
  });

  it('refuses a missing folder', async () => {
    expect(await codeOf(folderSource(join(tempDir(), 'nope')).revision())).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
  });
});

describe('folderSource refuses to escape its folder', () => {
  it('a symlinked file pointing outside', async () => {
    const outside = folderWith({ 'secret.txt': 'top secret' });
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.md'));
    const source = folderSource(dir);
    expect(await codeOf(source.read('leak.md'))).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(await source.list('')).not.toContain('leak.md');
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
  });

  it('a symlinked folder pointing outside, for reads and writes', async () => {
    const outside = folderWith({ 'secret.txt': 'top secret' });
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(outside, join(dir, 'ext'));
    const source = folderSource(dir);
    expect(await codeOf(source.read('ext/secret.txt'))).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(await source.list('')).toEqual(Object.keys(CONTRACT_FILES).sort());
    const expectedRevision = await source.revision();
    const write = source.write!({ 'ext/planted.md': 'x' }, { expectedRevision, by: 'person:eve', message: 'plant' });
    expect(await codeOf(write)).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(existsSync(join(outside, 'planted.md'))).toBe(false);
  });

  it('a .lousho folder symlinked outside', async () => {
    const outside = folderWith({});
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(outside, join(dir, '.lousho'));
    const source = folderSource(dir);
    const write = source.write!({ 'a.md': 'x' }, { expectedRevision: await source.revision(), by: 'person:eve', message: 'plant' });
    expect(await codeOf(write)).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a symlinked folder inside the workspace', async () => {
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(dir, 'pages'), join(dir, 'loop'));
    expect(await folderSource(dir).list('')).toEqual(Object.keys(CONTRACT_FILES).sort());
  });

  it('follows a symlinked file inside the workspace and skips a dangling one', async () => {
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(dir, 'pages-old', 'x.md'), join(dir, 'alias.md'));
    symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'));
    const source = folderSource(dir);
    expect(await source.read('alias.md')).toBe('old\n');
    expect(await source.list('')).toContain('alias.md');
    expect(await source.list('')).not.toContain('dangling.md');
  });
});

describe('folderSource bounds its reads', () => {
  it('a file over maxFileBytes', async () => {
    const source = folderSource(folderWith({ ...CONTRACT_FILES, 'big.md': 'x'.repeat(101) }), { maxFileBytes: 100 });
    expect(await codeOf(source.read('big.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
    expect(await codeOf(source.revision())).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
    expect(await source.read('workspace.json')).toBe(CONTRACT_FILES['workspace.json']);
  });
});
