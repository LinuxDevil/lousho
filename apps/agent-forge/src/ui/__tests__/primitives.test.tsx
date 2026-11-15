
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from './render';

import { StatusPill, statusTone, type StatusTone } from '../StatusPill';
import { ToastProvider, useToast } from '../Toast';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

afterEach(() => {
  vi.useRealTimers();
});

const TONE_CLASSES = ['pill-ok', 'pill-error', 'pill-warning', 'pill-running', 'pill-neutral'];
const pill = () => container.querySelector('.status-pill') as HTMLElement;
const toneClasses = (el: HTMLElement) => [...el.classList].filter((c) => TONE_CLASSES.includes(c));

describe('statusTone', () => {
  const vocabulary: [string, StatusTone][] = [
    // run
    ['ok', 'ok'],
    ['error', 'error'],
    ['running', 'running'],
    ['interrupted', 'warning'],
    // session
    ['active', 'ok'],
    ['ended', 'neutral'],
    // agent
    ['healthy', 'ok'],
    ['stale', 'warning'],
    ['down', 'error'],
    ['stopped', 'neutral'],
    // score
    ['pass', 'ok'],
    ['fail', 'error'],
    // builder run states
    ['idle', 'neutral'],
    ['done', 'ok'],
    ['paused', 'warning'],
  ];
  it('maps every status in the vocabulary to its tone', () => {
    for (const [status, tone] of vocabulary) expect(statusTone(status), status).toBe(tone);
  });
});

describe('StatusPill', () => {
  it('renders every status with exactly one tone class', () => {
    for (const status of ['ok', 'error', 'running', 'interrupted', 'healthy', 'stale', 'down', 'stopped', 'pass', 'fail', 'idle', 'done', 'paused']) {
      render(<StatusPill status={status} />);
      expect(toneClasses(pill()), status).toEqual([`pill-${statusTone(status)}`]);
      expect(pill().querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders a missing status as "none", never "unknown"', () => {
    render(<StatusPill status={null} />);
    expect(pill().textContent).toBe('none');
    expect(pill().textContent?.toLowerCase()).not.toContain('unknown');
    expect(toneClasses(pill())).toEqual(['pill-neutral']);
  });
});

describe('Toast', () => {
  let api: ReturnType<typeof useToast>;
  function Grab() {
    api = useToast();
    return null;
  }
  const renderToasts = () =>
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
  const toasts = () => [...container.querySelectorAll('.toast')] as HTMLElement[];
  const politeRegion = () => container.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;

  it('keeps a warning toast polite with a muted description for 8 s', () => {
    vi.useFakeTimers();
    renderToasts();
    act(() => void api.show({ message: 'Quota low', tone: 'warning', description: 'Two runs left today.' }));
    const toast = politeRegion().querySelector('.toast.toast-warning') as HTMLElement;
    expect(toast.getAttribute('role')).toBeNull();
    expect(toast.querySelector('.toast-description')?.textContent).toBe('Two runs left today.');
    act(() => void vi.advanceTimersByTime(7999));
    expect(toasts()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(toasts()).toHaveLength(0);
  });

  it('keeps error toasts as alerts until dismissed', () => {
    vi.useFakeTimers();
    renderToasts();
    act(() => void api.show({ message: 'Save failed', tone: 'error' }));
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Save failed');
    expect(politeRegion().textContent).not.toContain('Save failed');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(toasts()).toHaveLength(1);
    const close = alert.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement;
    act(() => close.click());
    expect(toasts()).toHaveLength(0);
  });
});
