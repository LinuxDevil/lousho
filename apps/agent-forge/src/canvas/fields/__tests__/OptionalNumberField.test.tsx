import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { OptionalNumberField, type OptionalNumberFieldProps } from '../OptionalNumberField';

let container: HTMLDivElement;
const render = (props: Partial<OptionalNumberFieldProps> = {}) => {
  container = mount(
    <OptionalNumberField id="node-agent-temperature" label="Temperature" value={undefined} onChange={vi.fn()} {...props} />,
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

describe('OptionalNumberField', () => {

  it('rejects an out-of-range number without emitting it', () => {
    const onChange = vi.fn();
    render({ onChange, min: 0, max: 2 });
    type(input(), '5');
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Enter a number from 0 to 2');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('recovers when the draft becomes valid again', () => {
    const onChange = vi.fn();
    render({ onChange, min: 0, max: 2, integer: true });
    type(input(), '1.5');
    type(input(), '1');
    expect(fieldError()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
