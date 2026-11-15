/**
 * AGENTS.md / CLAUDE.md auto-loading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions } from './projectInstructions';
import { createAgent } from './createAgent';
import { mockModel } from './testing';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'proj-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content = 'x'): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('loadProjectInstructions', () => {

  it('stops at `stopAt` (inclusive)', () => {
    put('AGENTS.md', 'top');
    mkdirSync(join(root, 'a/b/c'), { recursive: true });
    expect(loadProjectInstructions({ cwd: join(root, 'a/b/c'), stopAt: join(root, 'a/b') })).toBeUndefined();
    put('a/b/AGENTS.md', 'at stop');
    expect(loadProjectInstructions({ cwd: join(root, 'a/b/c'), stopAt: join(root, 'a/b') })?.content).toBe(
      'at stop'
    );
  });

  it('truncates long files with a marker', () => {
    put('.git/HEAD');
    put('AGENTS.md', 'a'.repeat(100));
    const found = loadProjectInstructions({ cwd: root, maxChars: 10 });
    expect(found?.content.startsWith('a'.repeat(10))).toBe(true);
    expect(found?.content).toContain('[... truncated');
    expect(found?.content).not.toContain('a'.repeat(11));
    expect(loadProjectInstructions({ cwd: root })?.content).toBe('a'.repeat(100));
  });
});

describe('createAgent({ projectInstructions })', () => {

  it('appends the file under a heading after the agent instructions', async () => {
    put('.git/HEAD');
    put('CLAUDE.md', 'use tabs');
    const model = mockModel(['ok']);
    const agent = createAgent({
      instructions: 'Be brief.',
      provider: model,
      projectInstructions: { cwd: root },
    });
    await agent.send('hi');
    expect(model.calls[0].messages[0].content).toBe(
      'Be brief.\n\n## Project instructions (from CLAUDE.md)\n\nuse tabs'
    );
  });

  it('`true` uses process.cwd() and leaves instructions alone when nothing is found', async () => {
    put('.git/HEAD');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const model = mockModel(['ok']);
    await createAgent({ instructions: 'Be brief.', provider: model, projectInstructions: true }).send('hi');
    expect(model.calls[0].messages[0].content).toBe('Be brief.');
  });
});
