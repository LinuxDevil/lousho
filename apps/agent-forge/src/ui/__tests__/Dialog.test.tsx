import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from './render';
import { ConfirmDialog, Dialog } from '../Dialog';
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

const dialog = () => document.querySelector('.dialog') as HTMLElement | null;
const footerButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.dialog-footer button')];

describe('Dialog', () => {

  it('ConfirmDialog primary uses btn-primary and focuses the confirm', () => {
    render(
      <ConfirmDialog
        open
        title="Publish version 3?"
        description="The published spec goes live for every trigger."
        confirmLabel="Publish"
        tone="primary"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const confirm = footerButtons()[1]!;
    expect(confirm.className).toContain('btn-primary');
    expect(document.activeElement).toBe(confirm);
  });

  it('pending swaps the label, disables both buttons and blocks Escape and scrim', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete “support-bot”?"
        description="This removes the agent. This can’t be undone."
        confirmLabel="Delete agent"
        pendingLabel="Deleting…"
        pending
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    const [cancel, confirm] = footerButtons();
    expect(confirm!.textContent).toBe('Deleting…');
    expect(cancel!.disabled).toBe(true);
    expect(confirm!.disabled).toBe(true);
    key('Escape', dialog()!);
    mouseDown(document.querySelector('.overlay-scrim')!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('a nested Dialog closes on Escape without reaching the Sheet under it', () => {
    const onSheetClose = vi.fn();
    const onDialogClose = vi.fn();
    render(
      <Sheet open onClose={onSheetClose} title="Versions">
        <Dialog open onClose={onDialogClose} title="Restore this version?" />
      </Sheet>,
    );
    expect(document.querySelector('.sheet')).not.toBeNull();
    key('Escape', dialog()!);
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(onSheetClose).not.toHaveBeenCalled();
    // And keys inside the nested dialog never reach the sheet's own handler.
    key('Tab', dialog()!);
    expect(onSheetClose).not.toHaveBeenCalled();
  });
});
