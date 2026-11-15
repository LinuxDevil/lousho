import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ToolCatalogPicker } from '../tool/ToolCatalogPicker';
import { refreshCatalog } from '../../useCatalog';
import { runtimeClient } from '../../../runtime/runtimeClient';
import type { CatalogTool } from '../../../../shared/wireTypes';

const tool = (over: Partial<CatalogTool>): CatalogTool => ({
  name: 'tool',
  description: 'Does a thing',
  inputJsonSchema: {},
  needsCredentials: [],
  mutating: false,
  optionsJsonSchema: null,
  toolNames: ['tool'],
  ...over,
});

const TOOLS: CatalogTool[] = [
  tool({ name: 'web_fetch', description: 'Fetches a URL' }),
  tool({ name: 'http_request', description: 'Calls an HTTP endpoint', mutating: true }),
  tool({ name: 'shell', description: 'Runs a command', mutating: true, needsCredentials: ['SHELL_KEY'] }),
  tool({ name: 'todo', description: 'Plan list' }),
];

const flush = () => act(async () => {});

let container: HTMLDivElement;
const onChange = vi.fn();

async function render(value = '') {
  container = mount(<ToolCatalogPicker id="node-tool-builtin" value={value} onChange={onChange} />);
  await flush();
}

const options = () => [...container.querySelectorAll('[role="option"]')] as HTMLElement[];
const search = () => container.querySelector('input[aria-label="Search tools"]') as HTMLInputElement;

function typeIn(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}


beforeEach(() => {
  onChange.mockReset();
  vi.spyOn(runtimeClient, 'catalogTools').mockResolvedValue(TOOLS);
});

afterEach(() => {
  refreshCatalog('tools');
  vi.restoreAllMocks();
});

describe('ToolCatalogPicker', () => {

  it('filters options by the search input', async () => {
    await render();
    typeIn(search(), 'http');
    expect(options().map((o) => o.querySelector('.tool-option-name')?.textContent)).toEqual([
      'http_request',
    ]);
  });

  it('marks the picked option aria-selected and emits on click', async () => {
    await render('web_fetch');
    const picked = options()[0];
    expect(picked.getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    act(() => options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('http_request');
  });

  it('shows the error and a Retry button that refetches the mounted catalog', async () => {
    const spy = vi.spyOn(runtimeClient, 'catalogTools').mockRejectedValue(new Error('offline'));
    await render();
    expect(container.textContent).toContain('offline');
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    spy.mockResolvedValue(TOOLS);
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(options().length).toBe(TOOLS.length);
    expect(container.textContent).not.toContain('offline');
  });
});
