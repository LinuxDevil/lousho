import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceIdFor } from '../workspaceId';
import { WorkspaceRegistry } from '../workspaceRegistry';

/**
 * The workspace registry (`workspaces.json`): the launch folder is
 * `ensure`d on every start, `add` validates the folder and rejects
 * duplicates by id (never by the raw path string), and every
 * read-modify-write runs inside `withAgentLock('workspaces:registry')`
 * so parallel adds both land. Timestamps come from an injected `now` so
 * the tests can see `lastOpenedAt` move.
 */
describe('WorkspaceRegistry', () => {
  let dir: string;
  let file: string;
  let tick: number;
  let registry: WorkspaceRegistry;

  /** One folder the registry can point at, under the temp dir. */
  function folder(name: string): string {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w01-reg-'));
    file = path.join(dir, 'state', 'workspaces.json');
    tick = Date.parse('2026-01-01T00:00:00.000Z');
    registry = new WorkspaceRegistry(file, () => new Date(tick));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ensure adds a new folder, and a second ensure keeps one entry and bumps lastOpenedAt', async () => {
    const a = folder('alpha');
    const first = await registry.ensure(a);
    expect(first).toMatchObject({
      id: workspaceIdFor(a),
      root: expect.any(String),
      addedAt: new Date(tick).toISOString(),
      lastOpenedAt: new Date(tick).toISOString(),
    });
    expect(await registry.list()).toHaveLength(1);

    tick += 60_000;
    const again = await registry.ensure(a);
    expect(again.id).toBe(first.id);
    expect(again.addedAt).toBe(first.addedAt);
    expect(again.lastOpenedAt).toBe(new Date(tick).toISOString());
    expect(await registry.list()).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    // Also missing on disk - the INVALID check must run before the stat.
    ['a relative path', path.join('some', 'relative', 'folder')],
  ])('add rejects %s with LOUSHO_WORKSPACE_ROOT_INVALID', async (_label, root) => {
    await expect(registry.add(root as string)).rejects.toMatchObject({
      code: 'LOUSHO_WORKSPACE_ROOT_INVALID',
      status: 400,
    });
    expect(await registry.list()).toEqual([]);
  });

  it('a corrupt file reads as [] with one console warning, and the next write replaces it', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const b = folder('beta');
    await registry.add(b);
    expect(await registry.list()).toHaveLength(1);
  });
});
