import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable, type Column, type TableSort } from '../DataTable';
import { render, rerender } from './render';

interface Row {
  id: string;
  name: string;
  tokens: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'alpha', tokens: 10 },
  { id: 'b', name: 'beta', tokens: 20 },
  { id: 'c', name: 'gamma', tokens: 30 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'tokens', header: 'Tokens', align: 'right', sortable: true, render: (r) => `${r.tokens} tok` },
  { key: 'id', header: <span>Id</span>, label: 'Identifier', hideBelow: 900, minWidth: 80 },
];

const STORE_KEY = 'forge.table.runs.widths';

/** In-memory Storage: jsdom's localStorage is unavailable under this Node (see HttpAgentStore.test.ts). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const click = (el: Element) => act(() => (el as HTMLElement).click());
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const pointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  });
const headers = (c: HTMLElement) => [...c.querySelectorAll('th')].map((th) => th.textContent?.trim());
const bodyRows = (c: HTMLElement) => [...c.querySelectorAll('tbody tr')] as HTMLTableRowElement[];
const sortButton = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('th button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const separator = (c: HTMLElement, label: string) =>
  c.querySelector(`[role="separator"][aria-label="Resize ${label}"]`) as HTMLElement;

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('DataTable sorting', () => {
  it('cycles desc -> asc -> none on one header and starts at desc on another', () => {
    const onSortChange = vi.fn();
    const props = { columns: COLUMNS, rows: ROWS, rowKey: (r: Row) => r.id, onSortChange, empty: 'x' };
    const c = render(<DataTable {...props} />);
    const nameTh = () => sortButton(c, 'Name').closest('th')!;
    expect(nameTh().getAttribute('aria-sort')).toBe('none');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', order: 'desc' });

    const sorted = (sort: TableSort) => rerender(<DataTable {...props} sort={sort} />);
    sorted({ key: 'name', order: 'desc' });
    expect(nameTh().getAttribute('aria-sort')).toBe('descending');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', order: 'asc' });

    sorted({ key: 'name', order: 'asc' });
    expect(nameTh().getAttribute('aria-sort')).toBe('ascending');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith(undefined);

    click(sortButton(c, 'Tokens'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'tokens', order: 'desc' });
    // never sorts rows itself
    expect(bodyRows(c).map((r) => r.textContent)).toEqual(['alpha10 toka', 'beta20 tokb', 'gamma30 tokc']);
  });
});

describe('DataTable keyboard and row open', () => {
  it('uses a roving tabindex, j/k and arrows move focus, Enter opens', () => {
    const onRowOpen = vi.fn();
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />);
    const rows = bodyRows(c);
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => rows[0].focus());
    key(rows[0], 'j');
    expect(document.activeElement).toBe(rows[1]);
    expect(bodyRows(c).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    key(rows[1], 'ArrowDown');
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2], 'j'); // clamps at the end
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2], 'k');
    key(rows[1], 'ArrowUp');
    key(rows[0], 'k'); // clamps at the start
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'Enter');
    expect(onRowOpen).toHaveBeenCalledWith(ROWS[0]);
  });

  it('ignores keys from editable targets inside a row', () => {
    const onRowOpen = vi.fn();
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', render: (r) => <input aria-label={`edit ${r.id}`} /> }];
    const c = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />);
    const input = c.querySelector('input')!;
    act(() => input.focus());
    key(input, 'j');
    key(input, 'Enter');
    expect(document.activeElement).toBe(input);
    expect(onRowOpen).not.toHaveBeenCalled();
  });
});

describe('DataTable column resize', () => {
  it('drags a header separator, clamps to minWidth, and remembers widths per table id', () => {
    setWidth(1200);
    const c = render(<DataTable id="runs" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    pointer(sep, 'pointerdown', 100);
    pointer(document, 'pointermove', 250);
    expect(sep.getAttribute('aria-valuenow')).toBe('210'); // 60 (min, jsdom has no layout) + 150
    pointer(document, 'pointerup', 250);
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 210 });
    expect((c.querySelectorAll('col')[0] as HTMLElement).style.width).toBe('210px');

    const idSep = separator(c, 'Identifier'); // non-string header uses `label`
    pointer(idSep, 'pointerdown', 500);
    pointer(document, 'pointermove', 0);
    pointer(document, 'pointerup', 0);
    expect(idSep.getAttribute('aria-valuenow')).toBe('80'); // minWidth

    rerender(<></>);
    const again = render(<DataTable id="runs" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(separator(again, 'Name').getAttribute('aria-valuenow')).toBe('210');
  });

  it('adjusts width by 16 px with ArrowLeft/ArrowRight on the separator', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 200 }];
    const c = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    expect(sep.getAttribute('aria-valuenow')).toBe('200');
    key(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe('216');
    key(sep, 'ArrowLeft');
    key(sep, 'ArrowLeft');
    expect(sep.getAttribute('aria-valuenow')).toBe('184');
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 184 });
  });

  it('does not persist without an id and survives corrupt or throwing storage', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 200 }];
    const c = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    key(separator(c, 'Name'), 'ArrowRight');
    expect(window.localStorage.length).toBe(0);

    window.localStorage.setItem(STORE_KEY, '{not json');
    const c2 = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(separator(c2, 'Name').getAttribute('aria-valuenow')).toBe('200');

    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const c3 = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    key(separator(c3, 'Name'), 'ArrowRight');
    expect(separator(c3, 'Name').getAttribute('aria-valuenow')).toBe('216');
  });
});

describe('DataTable responsive columns', () => {

  it('measures the wrapper with ResizeObserver when available', () => {
    let fire: ((width: number) => void) | undefined;
    const disconnect = vi.fn();
    class FakeRO {
      constructor(cb: ResizeObserverCallback) {
        fire = (width) => cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    try {
      setWidth(1200);
      const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
      act(() => fire!(500));
      expect(headers(c)).toEqual(['Name', 'Tokens']);
      act(() => fire!(950));
      expect(headers(c)).toEqual(['Name', 'Tokens', 'Id']);
      rerender(<></>);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('DataTable layout (review fixes)', () => {
  const css = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
  const rule = (src: string, sel: string) => src.match(new RegExp(`(^|\\n)${sel.replace(/[.[\]()*]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[2] ?? '';

  it('becomes a horizontal scroller (dt-scroll-x) only while the table is wider than the wrap', () => {
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const wrap = () => c.querySelector('.data-table-wrap') as HTMLElement;
    expect(wrap().classList.contains('dt-scroll-x')).toBe(false);
    offset.mockReturnValue(1200);
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="y" />);
    expect(wrap().classList.contains('dt-scroll-x')).toBe(true);
    offset.mockReturnValue(800);
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="z" />);
    expect(wrap().classList.contains('dt-scroll-x')).toBe(false);
    client.mockRestore();
  });

  it('maxHeight opts into a bounded scroller (both axes) whose header sticks inside it', () => {
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} maxHeight={480} empty="x" />);
    const wrap = c.querySelector('.data-table-wrap') as HTMLElement;
    expect(wrap.classList.contains('dt-scroll')).toBe(true);
    expect(wrap.style.maxHeight).toBe('480px');
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} maxHeight="calc(100dvh - 200px)" empty="x" />);
    expect(wrap.style.maxHeight).toBe('calc(100dvh - 200px)');
    expect(rule(css('dataTable.css'), '.data-table-wrap.dt-scroll')).toMatch(/overflow:\s*auto/);
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(wrap.classList.contains('dt-scroll')).toBe(false);
    expect(wrap.style.maxHeight).toBe('');
  });
});
