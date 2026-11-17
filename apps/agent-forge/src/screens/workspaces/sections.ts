import type { ReactNode } from 'react';
import type { WorkspaceSection } from './workspacesUrl';
import { OverviewSection } from './OverviewSection';
import { PagesSection } from './PagesSection';

export interface SectionEntry {
  id: WorkspaceSection;
  label: string;
}

export const WORKSPACE_SECTIONS: readonly SectionEntry[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'main-agent', label: 'Main agent' },
  { id: 'pages', label: 'Pages' },
  { id: 'agents', label: 'Agents' },
  { id: 'runs', label: 'Runs' },
  { id: 'improve', label: 'Improve' },
  { id: 'revisions', label: 'Revisions' },
];

export const SECTION_SCREENS: Partial<Record<WorkspaceSection, () => ReactNode>> = {
  overview: OverviewSection,
  pages: PagesSection,
};

export function isWorkspaceSection(value: string): value is WorkspaceSection {
  return WORKSPACE_SECTIONS.some((section) => section.id === value);
}
