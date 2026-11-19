import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ deleteExample: vi.fn<[string, string], Promise<void>>(async () => {}) }));
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: undefined }) }));
vi.mock('../../../observe/observeClient', () => ({ observeClient: client }));
vi.mock('../../../observe/useObserve', () => ({
  useDataset: () => ({
    loading: false,
    error: undefined,
    data: {
      dataset: { dataset_id: 'd1', name: 'support', description: null, created_at: 0, example_count: 1 },
      examples: [{ example_id: 'e1', dataset_id: 'd1', input: 'hi', expected: null, source_trace_id: null, created_at: 0 }],
      total: 1,
      limit: 25,
      offset: 0,
    },
  }),
  useDaemonDown: () => false,
}));

import { DatasetDetail } from '../DatasetDetail';
import { ToastProvider } from '../../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ToastProvider>
        <DatasetDetail name="support" />
      </ToastProvider>,
    ),
  );
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.body.querySelector('[role="alertdialog"]');
const rowDelete = () => container.querySelector('button[aria-label^="Delete"]') as HTMLButtonElement;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  client.deleteExample.mockClear();
});

describe('DatasetDetail delete example', () => {
  it('asks in a dialog and deletes once confirmed', async () => {
    render();
    act(() => rowDelete().click());
    expect(dialog()?.textContent).toContain('Delete example from support?');
    expect(client.deleteExample).not.toHaveBeenCalled();
    await act(async () => button(dialog()!, 'Delete example').click());
    expect(client.deleteExample).toHaveBeenCalledWith('support', 'e1');
    expect(dialog()).toBeNull();
  });

  it('does nothing when cancelled', () => {
    render();
    act(() => rowDelete().click());
    act(() => button(dialog()!, 'Cancel').click());
    expect(client.deleteExample).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
