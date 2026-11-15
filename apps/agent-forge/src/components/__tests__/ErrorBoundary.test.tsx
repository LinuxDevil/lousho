import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from '../ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new TypeError('n.filter is not a function');
}

describe('ErrorBoundary', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it('shows the error and a way out instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      )
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('n.filter is not a function');
    expect(container.textContent).toContain('Reload');
  });
});
