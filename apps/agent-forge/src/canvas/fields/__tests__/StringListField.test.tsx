import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { StringListField, type StringListFieldProps } from '../StringListField';

let container: HTMLDivElement;
const render = (props: Partial<StringListFieldProps> = {}) => {
  container = mount(
    <StringListField id="node-agent-fallbacks" label="Fallback models" value={undefined} onChange={vi.fn()} {...props} />,
  );
};

const input = () => container.querySelector('input')!;
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const enter = (el: HTMLInputElement) =>
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));

describe('StringListField', () => {

  it('commits the draft when the input loses focus', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(input(), '@playwright/mcp@latest');
    act(() => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(['@playwright/mcp@latest']);
    expect(input().value).toBe('');
  });

  it('ignores a duplicate item', () => {
    const onChange = vi.fn();
    render({ onChange, value: ['a'] });
    type(input(), 'a');
    enter(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('shows the validateItem message and keeps the draft for a rejected item', () => {
    const onChange = vi.fn();
    render({ onChange, validateItem: (item) => (item === 'bad' ? 'Not a known model' : undefined) });
    type(input(), 'bad');
    enter(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Not a known model');
    expect(input().value).toBe('bad');
  });
});
