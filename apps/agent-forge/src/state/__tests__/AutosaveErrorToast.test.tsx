import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ autosaveError: undefined as string | undefined, show: vi.fn() }));
vi.mock('../AppState', () => ({ useAppState: () => ({ autosaveError: mocks.autosaveError }) }));
vi.mock('../../ui/Toast', () => ({ useToast: () => ({ show: mocks.show }) }));

import { AutosaveErrorToast } from '../AutosaveErrorToast';
import { render, rerender as rerenderWith } from '../../ui/__tests__/render';

describe('AutosaveErrorToast', () => {
  it('toasts each distinct autosave error once and re-arms after a successful save', () => {
    mocks.autosaveError = 'tools[0] builtin "" does not exist';
    render(<AutosaveErrorToast />);
    const rerender = () => rerenderWith(<AutosaveErrorToast />);
    rerender();
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenLastCalledWith({ message: 'Not saved: tools[0] builtin "" does not exist', tone: 'error' });

    mocks.autosaveError = undefined;
    rerender();
    mocks.autosaveError = 'tools[0] builtin "" does not exist';
    rerender();
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });
});
