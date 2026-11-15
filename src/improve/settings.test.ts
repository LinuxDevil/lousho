import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { loadImproveSettings } from './settings';

let dir: string;

const file = (value: unknown): void => writeFileSync(path.join(dir, 'improve.json'), typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadImproveSettings', () => {

  it('refuses proposers outside 1 to 4 and an unknown mode, in the file and in flags', () => {
    for (const value of [{ editors: { proposers: 0 } }, { editors: { proposers: 5 } }, { editors: { proposers: 1.5 } }, { editors: { mode: 'deep' } }, { editors: { workers: 2 } }]) {
      file(value);
      expect(() => loadImproveSettings(dir, {}, {})).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringMatching(/editors/) }));
    }
    rmSync(path.join(dir, 'improve.json'));
    expect(() => loadImproveSettings(dir, { editors: { proposers: 9 } }, {})).toThrow(/--proposers/);
    expect(() => loadImproveSettings(dir, { editors: { mode: 'wide' as 'agg' } }, {})).toThrow(/--mode/);
  });

  it('rejects an unknown approval value', () => {
    expect(() => loadImproveSettings(dir, {}, { LOUSHO_IMPROVE_APPROVAL: 'yolo' })).toThrow(ConfigurationError);
    expect(() => loadImproveSettings(dir, { approval: 'sometimes' as 'auto' }, {})).toThrow(/--approval/);
    file({ approval: 'never' });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/approval/);
  });

  it('rejects an unknown key, a bad value and broken JSON with LOUSHO_CONFIG_INVALID', () => {
    file({ budget: { maxAppliesPerDay: 1, perHour: 2 } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    file({ monitor: { minRuns: 0 } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/monitor\.minRuns/);
    file({ canary: { traffic: { share: 0.5, sessions: 10 } } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/canary\.traffic\.share/);
    file('{ "approval": ');
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/not valid JSON/);
  });
});
