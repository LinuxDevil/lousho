import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { readAgentHarness, snapshotRevision } from './revisions';

let dir: string;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-revisions-'));
  write('instructions.md', 'Be careful.\n');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('readAgentHarness', () => {

  it('refuses a skill without a description', () => {
    write('skills/broken/SKILL.md', '---\nname: broken\n---\n\nBody.');
    expect(() => readAgentHarness(dir)).toThrow(ConfigurationError);
  });
});

describe('snapshotRevision', () => {

  it('marks loose and renamed skills as read-only', () => {
    write('skills/loose.md', '---\ndescription: When loose\n---\n\nLoose body.');
    write('skills/folder/SKILL.md', '---\nname: renamed\ndescription: When renamed\n---\n\nBody.');
    expect(snapshotRevision(dir, 'baseline').readOnly).toEqual(['loose', 'renamed']);
  });

  it('writes nothing outside .lousho/revisions', () => {
    snapshotRevision(dir, 'baseline');
    expect(readdirSync(dir).sort()).toEqual(['.lousho', 'instructions.md']);
    expect(readdirSync(path.join(dir, '.lousho'))).toEqual(['revisions']);
  });
});
