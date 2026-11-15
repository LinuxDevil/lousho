import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { memorySource } from '../source/memorySource';
import { readFixtureTree } from '../__fixtures__/readTree';
import { loadWorkspace } from './loadWorkspace';
import { WorkspaceValidationError } from './validationError';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function textFiles(tree: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

const marketing = (): Record<string, string> => textFiles(readFixtureTree('marketing'));

describe('loadWorkspace', () => {

  it('a write after loading does not change the loaded workspace', async () => {
    const source = memorySource(marketing());
    const loaded = await loadWorkspace(source, { mode: 'default' });
    const before = JSON.stringify({ tree: loaded.tree, manifest: loaded.manifest });
    await source.write?.({ 'pages/instagram-videos/harness/task.md': 'changed after loading\n' }, { expectedRevision: loaded.revision, by: 'person:ann', message: 'edit' });
    expect(await source.revision()).not.toBe(loaded.revision);
    expect(JSON.stringify({ tree: loaded.tree, manifest: loaded.manifest })).toBe(before);
    const pinned = await loadWorkspace(source, { revision: loaded.revision, mode: 'default' });
    expect(pinned.tree).toEqual(loaded.tree);
    const latest = await loadWorkspace(source, { mode: 'default' });
    expect(latest.tree['pages/instagram-videos/harness/task.md']).toBe('changed after loading\n');
  });

  it('an ops-desk workspace with no harness folder has no base and its own arrays per page', async () => {
    const loaded = await loadWorkspace(memorySource(textFiles(readFixtureTree('ops-desk'))), { mode: 'default' });
    const pages = Object.values(loaded.manifest.pages);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.inherits.base).toBeUndefined();
    expect(pages[0].inherits.shared).toEqual(['shared/instructions', 'shared/policies']);
    expect(pages[0].inherits.shared).not.toBe(pages[1].inherits.shared);
  });

  it('passes resolveGlobal to validation so pages can extend a global profile', async () => {
    const files = marketing();
    const page = JSON.parse(files['pages/facebook-videos/page.json']);
    files['pages/facebook-videos/page.json'] = JSON.stringify({ ...page, harness: { ...page.harness, extends: [...page.harness.extends, 'global:tones/calm@^1.0.0'] } });
    await expect(loadWorkspace(memorySource(files), { mode: 'default' })).rejects.toBeInstanceOf(WorkspaceValidationError);
    const profile = { 'harness.json': { schema: 'lousho.harness/1', id: 'calm', version: '1.0.0', instructions: ['calm.md'] }, 'calm.md': 'Stay calm.' };
    const resolveGlobal = (ref: string): Record<string, unknown> | undefined => (ref === 'global:tones/calm@^1.0.0' ? profile : undefined);
    const loaded = await loadWorkspace(memorySource(files), { mode: 'default', resolveGlobal });
    expect(loaded.manifest.pages['facebook-videos'].inherits.profiles).toContain('global:tones/calm@^1.0.0');
  });
});
