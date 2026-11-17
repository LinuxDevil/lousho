/**
 * Workspace ↔ observe-project mapping (W09b): Studio workspaces report
 * their runs under `observeProject` (`GET /workspaces`), and the
 * observe daemon groups traces/agents by that project. These helpers
 * turn the workspace list into the lookups the Traces facets and the
 * Monitoring fleet column need.
 */
import type { WorkspaceListItem } from '../../../shared/wireTypes';

/** One workspace's observe project and display name, for facets that pick by workspace. */
export interface WorkspaceProject {
  workspaceId: string;
  workspaceName: string;
  project: string;
}

/**
 * Every registered workspace that reports an `observeProject`, in list
 * order. Workspaces without one (or unavailable folders still report a
 * project - `observeProjectOf` falls back to `package.json`/`default`)
 * are all included; an empty `observeProject` is the only skip.
 */
export function workspaceProjects(list: readonly WorkspaceListItem[] | undefined): WorkspaceProject[] {
  return (list ?? [])
    .filter((w) => w.observeProject !== '')
    .map((w) => ({ workspaceId: w.id, workspaceName: w.name, project: w.observeProject }));
}

/**
 * project → workspace name. Two workspaces can share a project (same
 * `package.json` name, `LOUSHO_OBSERVE_PROJECT`, or the `default`
 * fallback); the launch workspace wins, then the first available one. A
 * workspace whose folder is missing never claims a project.
 */
export function projectWorkspaceNames(list: readonly WorkspaceListItem[] | undefined): Map<string, string> {
  const ranked = [...(list ?? [])].filter((w) => w.available).sort((a, b) => Number(b.isLaunch) - Number(a.isLaunch));
  const names = new Map<string, string>();
  for (const { project, workspaceName } of workspaceProjects(ranked)) {
    if (!names.has(project)) names.set(project, workspaceName);
  }
  return names;
}
