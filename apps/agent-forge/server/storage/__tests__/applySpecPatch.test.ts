import { describe, it, expect } from 'vitest';
import { applySpecPatch } from '../draftStore';
import type { SpecSnapshot } from '../../../shared/wireTypes';

const BASE: SpecSnapshot = {
  spec: {
    version: 2,
    name: 'ops',
    description: 'Runs the ops checks.',
    model: 'mock/mock-1',
    instructions: 'Check the queues.',
    maxSteps: 8,
    fallbackModels: ['mock/mock-2', 'mock/mock-3'],
  },
  labels: ['ops', 'nightly'],
};

describe('applySpecPatch', () => {

  it('sets labels from the patch, clears them on [] and on null, keeps them when absent', () => {
    expect(applySpecPatch(BASE, { labels: ['a'] }).labels).toEqual(['a']);
    expect(applySpecPatch(BASE, { labels: [] }).labels).toEqual([]);
    expect(applySpecPatch(BASE, { labels: null }).labels).toEqual([]);
    expect(applySpecPatch(BASE, { description: 'x' }).labels).toEqual(BASE.labels);
  });
});
