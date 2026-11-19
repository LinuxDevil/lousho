import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ deleteEvaluator: vi.fn<[string], Promise<void>>(async () => {}) }));
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: undefined }) }));
vi.mock('../../../observe/observeClient', () => ({ observeClient: client }));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: { listProviderKeys: async () => [] } }));
vi.mock('../../../observe/useObserve', () => ({
  useEvaluator: () => ({
    loading: false,
    error: undefined,
    data: {
      rule_id: 'r1',
      name: 'tone',
      enabled: true,
      kind: 'code',
      config: { source: 'return 1' },
      filter: {},
      sample_rate: 1,
      created_at: 0,
      updated_at: 0,
    },
  }),
  useDaemonDown: () => false,
  useAgents: () => ({ data: [] }),
}));

import { EvaluatorDetail } from '../EvaluatorDetail';
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
        <EvaluatorDetail ruleId="r1" />
      </ToastProvider>,
    ),
  );
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.body.querySelector('[role="alertdialog"]');

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  client.deleteEvaluator.mockClear();
});

describe('EvaluatorDetail delete', () => {
  it('asks in a dialog and deletes once confirmed', async () => {
    render();
    act(() => button(container, 'Delete').click());
    expect(dialog()?.textContent).toContain('Delete evaluator tone?');
    expect(dialog()?.textContent).toContain('Its past scores stay.');
    expect(client.deleteEvaluator).not.toHaveBeenCalled();
    await act(async () => button(dialog()!, 'Delete evaluator').click());
    expect(client.deleteEvaluator).toHaveBeenCalledWith('r1');
    expect(dialog()).toBeNull();
  });

  it('does nothing when cancelled', () => {
    render();
    act(() => button(container, 'Delete').click());
    act(() => button(dialog()!, 'Cancel').click());
    expect(client.deleteEvaluator).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
