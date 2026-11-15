import { describe, expect, it } from 'vitest';

import { MetricCard } from '../MetricCard';
import { render } from './render';

const delta = (c: HTMLElement) => c.querySelector('.metric-delta') as HTMLElement;
const spoken = (c: HTMLElement) => delta(c).querySelector('.visually-hidden')?.textContent;
const ms = (v: number) => `${v} ms`;

describe('MetricCard', () => {

  it('zero is neutral, and format / label shape the text', () => {
    const c = render(<MetricCard label="p95" value="1.2s" delta={{ value: 0, format: ms, label: 'vs yesterday' }} />);
    expect(delta(c).dataset.tone).toBe('neutral');
    expect(spoken(c)).toBe('no change vs yesterday');
    const down = render(<MetricCard label="p95" value="1.2s" delta={{ value: -40, format: ms, label: 'vs yesterday' }} />);
    expect(spoken(down)).toBe('down 40 ms vs yesterday');
  });
});
