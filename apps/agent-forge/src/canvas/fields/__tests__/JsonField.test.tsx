import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { JsonField, type JsonFieldProps } from '../JsonField';

let container: HTMLDivElement;
const render = (props: Partial<JsonFieldProps> = {}) => {
  container = mount(<JsonField id="node-tool-options" label="Options" value={undefined} onChange={vi.fn()} {...props} />);
};

const textarea = () => container.querySelector('textarea')!;
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const blur = (el: Element) => act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

describe('JsonField', () => {

  it('keeps the draft and shows the parse error for invalid JSON', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(textarea(), '{bad');
    blur(textarea());
    expect(onChange).not.toHaveBeenCalled();
    expect(textarea().value).toBe('{bad');
    expect(fieldError()).toContain('This is not valid JSON:');
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
  });
});
