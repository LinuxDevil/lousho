import { describe, it, expect } from 'vitest';
import { baseHarnessLayer, readBaseHarness } from './baseHarness';

const base = { schema: 'lousho.harness/1', constraints: [{ id: 'no-competitors', text: 'Never name a competitor.' }], runtime: { limits: { maxTurns: 10 } } };

describe('baseHarnessLayer', () => {

  it('a workspace.json that is not JSON is a problem', () => {
    expect(readBaseHarness({ 'workspace.json': '{' }).problems).toEqual([{ path: 'workspace.json', message: 'is not valid JSON' }]);
  });

  it.each(['../out', 'a/../b'])('a manifest harness folder %s is a problem on workspace.json', (folder) => {
    const result = readBaseHarness({ 'workspace.json': { harness: folder }, 'harness/harness.json': base });
    expect(result.layer).toBeUndefined();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.path).toBe('workspace.json');
    expect(result.problems[0]?.message).toContain('relative folder path');
  });

  it('a folder named by workspace.json with no files is a problem, not no layer', () => {
    const tree = { 'workspace.json': { harness: 'rules/base' }, 'harness/harness.json': base };
    expect(readBaseHarness(tree).problems).toEqual([{ path: 'rules/base', message: 'is named by workspace.json harness but has no files' }]);
    expect(() => baseHarnessLayer(tree)).toThrow('rules/base');
  });

  it('a base harness with a forbidden key is an error naming R13, without a doubled prefix', () => {
    const problems = readBaseHarness({ 'harness/harness.json': { ...base, tools: [] } }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/^harness\.tools: .*\(R13\)$/);
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, tools: [] } })).toThrow(/^harness\/harness\.json: harness\.tools: .*R13/);
  });
});
