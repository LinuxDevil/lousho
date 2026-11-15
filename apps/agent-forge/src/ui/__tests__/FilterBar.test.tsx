
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from './render';

import { FilterBar, type FacetDef } from '../FilterBar';
import { formatTimeRange, parseTimeRange, type TimeRange } from '../TimeRangePicker';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

afterEach(() => {
  vi.useRealTimers();
});

/** Fire a React-visible value change on an input. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());
const byText = (sel: string, text: string) =>
  [...container.querySelectorAll(sel)].find((e) => e.textContent?.includes(text)) as HTMLElement;

describe('toWindow / parse / format', () => {
  it('round-trips and rejects garbage', () => {
    const ranges: TimeRange[] = [{ preset: '7d' }, { from: 1000, to: 2000 }];
    for (const r of ranges) expect(parseTimeRange(formatTimeRange(r))).toEqual(r);
    expect(formatTimeRange({ preset: '24h' })).toBe('24h');
    expect(formatTimeRange({ from: 5, to: 9 })).toBe('5-9');
    for (const bad of [null, '', 'abc', '2h', '9-5', '1-', '-1', '1-2-3']) expect(parseTimeRange(bad)).toBeNull();
  });
});

describe('FilterBar search', () => {

  it('keeps what the user typed when the parent echoes a trimmed value, but follows real external changes', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const ui = (value: string) => <FilterBar facets={[]} search={{ value, onChange }} />;
    render(ui(''));
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    type(input, 'tool ');
    act(() => void vi.advanceTimersByTime(250));
    expect(onChange).toHaveBeenCalledWith('tool ');
    rerender(ui('tool'));
    expect(input.value).toBe('tool ');
    type(input, 'tool timed out');
    act(() => void vi.advanceTimersByTime(250));
    rerender(ui('tool timed out'));
    expect(input.value).toBe('tool timed out');
    rerender(ui(''));
    expect(input.value).toBe('');
    rerender(ui('tool timed out'));
    expect(input.value).toBe('tool timed out');
  });
});

describe('FilterBar facets', () => {
  const facet = (value: string[], onChange = vi.fn()): FacetDef => ({
    key: 'status',
    label: 'Status',
    value,
    onChange,
    options: [
      { value: 'ok', label: 'OK', count: 7 },
      { value: 'error', label: 'Error' },
    ],
  });

  it('shows the selected count, toggles options, and clear emits []', () => {
    const onChange = vi.fn();
    render(<FilterBar facets={[facet(['ok'], onChange)]} />);
    const btn = byText('button.facet-btn', 'Status');
    expect(btn.textContent).toContain('1');
    click(btn);
    expect(container.textContent).toContain('7');
    click(container.querySelectorAll('.facet-pop input')[1]);
    expect(onChange).toHaveBeenLastCalledWith(['ok', 'error']);
    click(container.querySelectorAll('.facet-pop input')[0]);
    expect(onChange).toHaveBeenLastCalledWith([]);
    click(byText('button', 'Clear'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('Esc closes and refocuses the button; outside click closes', () => {
    render(<FilterBar facets={[facet([])]} />);
    const btn = byText('button.facet-btn', 'Status');
    click(btn);
    expect(container.querySelector('.facet-pop')).not.toBeNull();
    const cb = container.querySelector('.facet-pop input') as HTMLElement;
    cb.focus();
    act(() => void cb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('.facet-pop')).toBeNull();
    expect(document.activeElement).toBe(btn);
    click(btn);
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container.querySelector('.facet-pop')).toBeNull();
  });
});

describe('TimeRangePicker via FilterBar', () => {

  it('custom range: Apply is disabled when from >= to', () => {
    const onChange = vi.fn();
    render(<FilterBar facets={[]} range={{ value: { preset: '1h' }, onChange }} />);
    click(byText('.time-range button', 'Custom'));
    const [from, to] = [...container.querySelectorAll('input[type="datetime-local"]')] as HTMLInputElement[];
    const apply = byText('.time-range button', 'Apply') as HTMLButtonElement;
    type(from, '2026-01-02T10:00');
    type(to, '2026-01-02T10:00');
    expect(apply.disabled).toBe(true);
    type(to, '2026-01-02T11:00');
    expect(apply.disabled).toBe(false);
    click(apply);
    expect(onChange).toHaveBeenCalledWith({
      from: new Date('2026-01-02T10:00').getTime(),
      to: new Date('2026-01-02T11:00').getTime(),
    });
  });
});
