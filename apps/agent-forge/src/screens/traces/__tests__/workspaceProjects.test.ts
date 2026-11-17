import { describe, expect, it } from 'vitest';
import type { WorkspaceListItem } from '../../../../shared/wireTypes';
import { projectWorkspaceNames } from '../workspaceProjects';

const ws = (name: string, extra: Partial<WorkspaceListItem>): WorkspaceListItem =>
  ({ id: name, name, root: `/${name}`, isLaunch: false, available: true, agentCount: 0, observeProject: 'default', ...extra }) as WorkspaceListItem;

describe('projectWorkspaceNames', () => {
  it('gives a shared project to the launch workspace, never to a missing folder', () => {
    const names = projectWorkspaceNames([ws('a-missing', { available: false }), ws('b-extra', {}), ws('main', { isLaunch: true }), ws('shop', { observeProject: 'shop' })]);
    expect(names.get('default')).toBe('main');
    expect(names.get('shop')).toBe('shop');
  });
});
