import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SettingsStore } from './settingsStore';

describe('SettingsStore', () => {
  let baseDir: string;
  let store: SettingsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-settings-'));
    store = new SettingsStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('seeds default local/staging/prod profiles with local active, before anything is saved', () => {
    const { activeProfileId, profiles } = store.list();
    expect(activeProfileId).toBe('local');
    expect(profiles.map((p) => p.id)).toEqual(['local', 'staging', 'prod']);
    expect(store.activeProfile().providerType).toBe('mock');
  });

  it('removes a profile and re-points activeProfileId when the active one was removed', () => {
    store.setActive('staging');
    const result = store.removeProfile('staging');
    expect(result.profiles.map((p) => p.id)).not.toContain('staging');
    expect(result.activeProfileId).not.toBe('staging');
  });

  it('refuses to remove the last remaining profile', () => {
    store.removeProfile('staging');
    store.removeProfile('prod');
    expect(() => store.removeProfile('local')).toThrow(/last remaining/);
  });
});
