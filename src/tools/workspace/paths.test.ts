import { describe, it, expect } from 'vitest';
import { createDenyTest, normalizeAllowedPath, normalizeWorkspacePath, WorkspaceError } from './paths';
import { globToRegExp } from './glob';

describe('normalizeWorkspacePath', () => {
  it.each([
    ['src/x/../a.ts', 'src/a.ts'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeWorkspacePath(input, 'linux')).toBe(expected);
  });

  it.each([
    ['../secret', /climbs above/],
    ['a/../../secret', /climbs above/],
    ['a\0b', /NUL/],
  ])('rejects %j on every platform', (input, reason) => {
    for (const platform of ['linux', 'win32']) {
      expect(() => normalizeWorkspacePath(input, platform)).toThrow(WorkspaceError);
      expect(() => normalizeWorkspacePath(input, platform)).toThrow(reason);
    }
  });

  it('rejects Windows-only hazards on win32 and allows them elsewhere', () => {
    expect(() => normalizeWorkspacePath('file.txt:stream', 'win32')).toThrow(/alternate data streams/);
    expect(() => normalizeWorkspacePath('NUL', 'win32')).toThrow(/reserved Windows device/);
    expect(() => normalizeWorkspacePath('dir/con.txt', 'win32')).toThrow(/reserved Windows device/);
    expect(() => normalizeWorkspacePath('.. /x', 'win32')).toThrow(/dots and spaces/);
    expect(() => normalizeWorkspacePath('a/... ', 'win32')).toThrow(/dots and spaces/);
    expect(normalizeWorkspacePath('file.txt:stream', 'linux')).toBe('file.txt:stream');
    expect(normalizeWorkspacePath('NUL', 'linux')).toBe('NUL');
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.{js,jsx}', 'x.jsx', true],
    ['[unclosed', '[unclosed', true],
  ])('%j vs %j -> %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });
});

describe('createDenyTest (consumer harness H1-2)', () => {

  it('denies 8.3 short-name aliases on Windows only', () => {
    for (const alias of ['GIT~1/config', 'git~2', 'GI4F2A~1/HEAD']) {
      expect(createDenyTest(['.git'], 'win32')(alias)).toBeDefined();
      expect(createDenyTest(['.git'], 'linux')(alias)).toBeUndefined();
    }
  });

  it('normalizeAllowedPath normalizes first, so ./, .. and backslashes cannot hide a denied segment', () => {
    const isDenied = createDenyTest(['.git'], 'linux');
    for (const path of ['./.git/config', 'a/../.git/config', '.git\\config', '.git/', 'x\\..\\.git']) {
      expect(() => normalizeAllowedPath(path, isDenied)).toThrow(WorkspaceError);
    }
    expect(normalizeAllowedPath('./src//a.ts', isDenied)).toBe('src/a.ts');
  });
});
