import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ deleteAgent: vi.fn<[string], Promise<void>>(async () => {}) }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { AgentCardActions } from '../LeftRail';
import type { AgentListItem as AgentEntry } from '../../../shared/wireTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const entry = { id: 'support' } as AgentEntry;
  act(() => root!.render(<AgentCardActions entry={entry} busy={false} onRename={() => {}} />));
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.body.querySelector('[role="alertdialog"]');
const trash = () => container.querySelector('button[aria-label="Delete support"]') as HTMLButtonElement;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  appState.deleteAgent.mockClear();
});

describe('AgentCardActions delete', () => {
  it('asks in a dialog and deletes once confirmed', async () => {
    render();
    act(() => trash().click());
    expect(dialog()?.textContent).toContain("Delete agent 'support'?");
    expect(dialog()?.textContent).toContain('This removes .lousho/agents/support.yaml.');
    expect(appState.deleteAgent).not.toHaveBeenCalled();
    await act(async () => button(dialog()!, 'Delete agent').click());
    expect(appState.deleteAgent).toHaveBeenCalledWith('support');
    expect(dialog()).toBeNull();
  });

  it('does nothing when cancelled', () => {
    render();
    act(() => trash().click());
    act(() => button(dialog()!, 'Cancel').click());
    expect(appState.deleteAgent).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
