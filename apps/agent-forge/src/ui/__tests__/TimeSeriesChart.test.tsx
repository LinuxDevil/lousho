
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimeSeriesChart, type TimeSeries } from '../TimeSeriesChart';
import { render } from './render';

const MIN = 60_000;
/** 10:00 local time on an arbitrary day, so HH:MM labels are predictable. */
const FROM = new Date(2026, 9, 25, 10, 0, 0, 0).getTime();
const TO = FROM + 60 * MIN;
const BUCKET = 5 * MIN; // 12 buckets

const fmt = (v: number) => `${v} req`;

const SERIES: TimeSeries[] = [
  {
    id: 'ok',
    label: 'Requests',
    color: 'accent',
    points: [
      { t: FROM, v: 4 },
      { t: FROM + BUCKET + 10, v: 7 },
      { t: FROM + 2 * BUCKET, v: 23 },
    ],
  },
  { id: 'err', label: 'Errors', color: 'danger', points: [{ t: FROM + BUCKET, v: 2 }] },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const svgOf = (c: HTMLElement) => c.querySelector('svg.tsc-svg') as SVGSVGElement;
const plotOf = (c: HTMLElement) => c.querySelector('.tsc-plot') as SVGRectElement;
const statusOf = (c: HTMLElement) => c.querySelector('[role="status"]') as HTMLElement;

/** Make the svg report a 600 px wide box at the viewport origin (jsdom has no layout). */
function stubRect(c: HTMLElement) {
  vi.spyOn(svgOf(c), 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 600, bottom: 200, width: 600, height: 200, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
}
const pointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  });
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

/** Bucket centre x in the default 600 px layout (plot from x=48 to x=588). */
const centreX = (k: number, n = 12) => 48 + ((k + 0.5) * 540) / n;

describe('TimeSeriesChart', () => {

  it('hover snaps to a bucket and shows a crosshair tooltip with every series value', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    stubRect(c);
    pointer(plotOf(c), 'pointermove', centreX(1) + 5);
    const cross = c.querySelector('.tsc-crosshair')!;
    expect(Number(cross.getAttribute('x1'))).toBeCloseTo(centreX(1));
    const tip = statusOf(c).textContent!;
    expect(tip).toContain('10:05');
    expect(tip).toContain('10:10');
    expect(tip).toContain('Requests');
    expect(tip).toContain('7 req');
    expect(tip).toContain('Errors');
    expect(tip).toContain('2 req');

    pointer(plotOf(c), 'pointermove', centreX(5));
    expect(statusOf(c).textContent).toContain('Errors—');

    // React derives onPointerLeave from pointerout towards an element outside the plot.
    act(() => {
      plotOf(c).dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(c.querySelector('.tsc-crosshair')).toBeNull();
    expect(statusOf(c).textContent).toBe('');
  });

  it('keyboard: arrows move the hovered bucket, Enter clicks it, Escape clears', () => {
    const onBucketClick = vi.fn();
    const c = render(
      <TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} onBucketClick={onBucketClick} />,
    );
    const svg = svgOf(c);
    expect(svg.getAttribute('tabindex')).toBe('0');
    key(svg, 'ArrowRight');
    expect(statusOf(c).textContent).toContain('10:00');
    key(svg, 'ArrowRight');
    key(svg, 'ArrowRight');
    key(svg, 'ArrowLeft');
    key(svg, 'Enter');
    expect(onBucketClick).toHaveBeenCalledWith(FROM + BUCKET, FROM + 2 * BUCKET);
    key(svg, 'ArrowLeft');
    key(svg, 'ArrowLeft');
    key(svg, 'Enter');
    expect(onBucketClick).toHaveBeenLastCalledWith(FROM, FROM + BUCKET);
    key(svg, 'Escape');
    expect(statusOf(c).textContent).toBe('');
    key(svg, 'ArrowLeft');
    expect(statusOf(c).textContent).toContain('10:55');
  });

  it('follows its container width when ResizeObserver is available', () => {
    let fire: (w: number) => void = () => {};
    class FakeRO {
      constructor(cb: ResizeObserverCallback) {
        fire = (width) => cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} height={120} />);
    act(() => fire(900));
    expect(svgOf(c).getAttribute('width')).toBe('900');
    expect(svgOf(c).getAttribute('height')).toBe('120');
  });

  it('legend chips toggle a series (aria-pressed); the last visible series cannot be hidden', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const chip = (name: string) =>
      [...c.querySelectorAll<HTMLButtonElement>('.tsc-legend button')].find((b) => b.textContent === name)!;
    expect(chip('Requests').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('true');

    act(() => chip('Errors').click());
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('[data-series="err"]')).toBeNull();
    expect(c.querySelector('polyline[data-series="ok"]')).not.toBeNull();
    // The hidden series leaves the tooltip too.
    stubRect(c);
    pointer(plotOf(c), 'pointermove', centreX(1));
    expect(statusOf(c).textContent).toContain('Requests');
    expect(statusOf(c).textContent).not.toContain('Errors');

    // The only visible series stays on: its chip is pressed and disabled.
    expect(chip('Requests').disabled).toBe(true);
    act(() => chip('Requests').click());
    expect(c.querySelector('polyline[data-series="ok"]')).not.toBeNull();

    act(() => chip('Errors').click());
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Requests').disabled).toBe(false);
    expect(c.querySelector('circle[data-series="err"]')).not.toBeNull();
  });
});
