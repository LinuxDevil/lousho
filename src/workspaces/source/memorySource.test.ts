import { describe, expect, it } from 'vitest';
import { memorySource } from './memorySource';
import { sourceContract } from './__fixtures__/sourceContract';

sourceContract('memorySource', async (files) => memorySource(files));

describe('memorySource', () => {
  it('defaults its ref and takes the given ids', () => {
    expect(memorySource({}).ref).toEqual({ projectId: 'default', workspaceId: 'workspace' });
    expect(memorySource({}, { ref: { projectId: 'acme', workspaceId: 'marketing' } }).ref).toEqual({ projectId: 'acme', workspaceId: 'marketing' });
  });

  it('refuses initial files outside the workspace, or that clash', () => {
    expect(() => memorySource({ '../x': 'y' })).toThrow(/LOUSHO_WORKSPACE_PATH_INVALID/);
    expect(() => memorySource({ b: '1', 'b/c': '2' })).toThrow(/LOUSHO_WORKSPACE_PATH_INVALID/);
    expect(() => memorySource({ 'A.md': '1', 'a.md': '2' })).toThrow(/LOUSHO_WORKSPACE_PATH_INVALID/);
  });
});
