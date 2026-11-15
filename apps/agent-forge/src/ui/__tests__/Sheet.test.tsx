import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from './render';
import { Sheet } from '../Sheet';

const noop = () => {};

const key = (k: string, target: Element, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });

const mouseDown = (target: Element) =>
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });

const sheet = () => document.querySelector('.sheet') as HTMLElement | null;

describe('Sheet', () => {

  it('Escape keydown and scrim mousedown close; mousedown inside does not', () => {
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose} title="T">body</Sheet>);
    key('Escape', sheet()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(document.querySelector('.sheet-body')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(sheet()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(document.querySelector('.overlay-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab and Shift+Tab inside the panel', () => {
    render(
      <Sheet open onClose={noop} title="T">
        <button type="button">A</button>
        <button type="button">B</button>
      </Sheet>,
    );
    const close = sheet()!.querySelector('.sheet-close')!;
    const [a, b] = [...sheet()!.querySelectorAll<HTMLButtonElement>('.sheet-body button')];
    // DOM order: close, A, B. Opening put focus on close.
    expect(document.activeElement).toBe(close);
    key('Tab', close);
    expect(document.activeElement).toBe(a);
    key('Tab', a!);
    expect(document.activeElement).toBe(b);
    // Tab from the last focusable wraps to the first.
    key('Tab', b!);
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first wraps to the last.
    key('Tab', close, { shiftKey: true });
    expect(document.activeElement).toBe(b);
    key('Tab', b!, { shiftKey: true });
    expect(document.activeElement).toBe(a);
  });
});
