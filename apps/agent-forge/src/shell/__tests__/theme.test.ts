import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  applyStoredDensity,
  getDensity,
  getThemeChoice,
  setThemeChoice,
} from '../theme';

const root = document.documentElement;

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  root.removeAttribute('data-theme');
  root.removeAttribute('data-density');
  window.localStorage.clear();
});

describe('theme choice', () => {

  it('"system" removes both the attribute and the stored key', () => {
    setThemeChoice('dark');
    setThemeChoice('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('forge.theme')).toBeNull();
    expect(getThemeChoice()).toBe('system');
  });
});

describe('table density', () => {

  it('applyStoredDensity re-applies a remembered density and ignores garbage', () => {
    window.localStorage.setItem('forge.density', 'compact');
    applyStoredDensity();
    expect(getDensity()).toBe('compact');
    root.removeAttribute('data-density');
    window.localStorage.setItem('forge.density', 'roomy');
    applyStoredDensity();
    expect(getDensity()).toBeNull();
  });
});
