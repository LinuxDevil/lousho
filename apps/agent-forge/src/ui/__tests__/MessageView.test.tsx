
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from './render';

import { MessageView } from '../MessageView';
import { JsonView } from '../JsonView';

const CHAT = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"temp":4}' },
  { role: 'assistant', content: 'It is 4 degrees.' },
];

const bubbles = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.mv-bubble')];
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const click = (el: HTMLElement | undefined) => {
  expect(el).toBeDefined();
  act(() => el!.click());
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MessageView', () => {

  it('gives each role its avatar icon and bubble style; tool content is a mono block', () => {
    const c = render(<MessageView value={JSON.stringify(CHAT)} label="Input" />);
    const list = bubbles(c);
    const avatar = (b: HTMLElement) => {
      const tile = b.querySelector('.mv-avatar')!;
      expect(tile.getAttribute('aria-hidden')).toBe('true');
      return tile.querySelector('svg')!.getAttribute('class');
    };
    expect(avatar(list[0])).toContain('lucide-settings-2');
    expect(avatar(list[1])).toContain('lucide-user');
    expect(avatar(list[2])).toContain('lucide-bot');
    expect(avatar(list[3])).toContain('lucide-wrench');
    expect(list[3].querySelector('.mv-content')?.classList.contains('mv-mono')).toBe(true);
    expect(list[1].querySelector('.mv-content')?.classList.contains('mv-mono')).toBe(false);
    // Tool-call chips lead with a wrench too; the chip text is unchanged.
    expect(list[2].querySelector('.mv-chip svg')?.getAttribute('class')).toContain('lucide-wrench');
    const unknown = render(<MessageView value={JSON.stringify([{ role: 'developer', content: 'x' }])} />);
    expect(unknown.querySelector('.mv-avatar svg')?.getAttribute('class')).toContain('lucide-message-square');
  });

  it('uses the mono block only for string tool content; object content is a JsonView without it', () => {
    const c = render(
      <MessageView
        value={JSON.stringify([
          { role: 'tool', tool_call_id: 't1', content: { temp: 4 } },
          { role: 'tool', tool_call_id: 't2', content: 'plain result' },
        ])}
      />,
    );
    const [obj, text] = bubbles(c);
    expect(obj.querySelector('.json-view')).not.toBeNull();
    expect(obj.querySelector('.mv-mono')).toBeNull();
    expect(text.querySelector('.mv-content')?.classList.contains('mv-mono')).toBe(true);
  });

  it('Raw shows the exact string', () => {
    const raw = JSON.stringify(CHAT, null, 2);
    const c = render(<MessageView value={raw} />);
    click(button(c, 'Raw'));
    expect(c.querySelector('pre.mv-raw')?.textContent).toBe(raw);
    expect(bubbles(c)).toHaveLength(0);
  });

  it('JSON mode shows a JsonView of the parsed value', () => {
    const c = render(<MessageView value={JSON.stringify(CHAT)} />);
    click(button(c, 'JSON'));
    expect(bubbles(c)).toHaveLength(0);
    expect(c.querySelector('.json-node')).not.toBeNull();
  });

  it('renders a 64 KB string without blocking, behind a Show all button', () => {
    const big = 'x'.repeat(64 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={big} />);
    expect(performance.now() - start).toBeLessThan(50);
    expect(c.querySelector('.mv-text')!.textContent!.length).toBeLessThan(big.length);
    click(button(c, 'Show all (64 KB)'));
    expect(c.querySelector('.mv-text')?.textContent).toBe(big);
  });

  it('renders 64 KB of truncated JSON as text without blocking', () => {
    const truncated = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ i, s: 'abcdefgh' }))).slice(0, 64 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={truncated} />);
    expect(performance.now() - start).toBeLessThan(50);
    expect(c.querySelector('.mv-text')).not.toBeNull();
    expect(button(c, 'JSON')).toBeUndefined();
  });

  it('stringifies non-string tool-call fields instead of crashing', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', name: { odd: 1 } }], tool_calls: [{ id: 7, function: { name: 9, arguments: { city: 'Oslo' } } }] },
      { role: 'tool', tool_call_id: 42, content: 'ok' },
    ];
    const c = render(<MessageView value={JSON.stringify(msgs)} />);
    const chips = [...c.querySelectorAll('.mv-chip')].map((el) => el.textContent);
    expect(chips).toEqual(['{"odd":1}', '9{"city":"Oslo"}']);
    expect(c.querySelector('.mv-call-id')?.textContent).toBe('42');
  });

  it('bounds ~64 KB of valid JSON by structure: 100 entries per container plus Show more', () => {
    const big = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ i, s: 'abcdefgh' })));
    expect(big.length).toBeGreaterThan(60 * 1024);
    const start = performance.now();
    const c = render(<MessageView value={big} />);
    // Wall clock is only a loose ceiling (CI runners are slow); the structural cap is the real guard.
    expect(performance.now() - start).toBeLessThan(500);
    const root = c.querySelector('.json-children')!;
    expect(root.querySelectorAll(':scope > .json-node')).toHaveLength(100);
    // 100 shown items, each with its index key plus two inner keys.
    expect(c.querySelectorAll('.json-key').length).toBeLessThanOrEqual(300);
    expect(button(c, 'Show 3900 more')).toBeDefined();
  });

  it('copies the exact block string with the copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const raw = JSON.stringify(CHAT);
    const c = render(<MessageView value={raw} label="Input" />);
    await act(async () => {
      button(c, 'Copy')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(button(c, 'Copied')).toBeDefined();
  });
});

describe('JsonView', () => {
  it('expands four levels by default and lets a collapsed level open', () => {
    const c = render(<JsonView value={{ a: { b: { c: { d: { e: 1 } } } } }} />);
    expect([...c.querySelectorAll('.json-key')].map((k) => k.textContent)).toEqual(['a: ', 'b: ', 'c: ', 'd: ']);
    expect(c.querySelector('.json-num')).toBeNull();
    const collapsed = [...c.querySelectorAll<HTMLButtonElement>('.json-toggle')].find(
      (b) => b.getAttribute('aria-expanded') === 'false',
    );
    expect(collapsed?.getAttribute('aria-label')).toBe('Toggle d');
    click(collapsed);
    expect(collapsed?.getAttribute('aria-label')).toBe('Toggle d');
    expect(c.querySelector('.json-num')?.textContent).toBe('1');
  });

  it('caps a large container at 100 entries with a Show more row', () => {
    const c = render(<JsonView value={Array.from({ length: 250 }, (_, i) => i)} />);
    expect(c.querySelectorAll('.json-num')).toHaveLength(100);
    click(button(c, 'Show 150 more'));
    expect(c.querySelectorAll('.json-num')).toHaveLength(250);
  });
});
