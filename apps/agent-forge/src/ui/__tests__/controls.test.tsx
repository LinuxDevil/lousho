import { describe, expect, it } from 'vitest';

import { render as mount } from './render';
import { Checkbox, Select, Switch, Textarea } from '../controls';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

const noop = () => {};

describe('Select', () => {
  it('renders a disabled placeholder option first, keeps option order and supports controlSize="sm"', () => {
    render(
      <Select
        value=""
        onChange={noop}
        placeholder="Pick a model"
        controlSize="sm"
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta', disabled: true },
        ]}
      />,
    );
    const select = container.querySelector('select')!;
    const options = [...select.querySelectorAll('option')];
    expect(options[0].value).toBe('');
    expect(options[0].disabled).toBe(true);
    expect(options[0].textContent).toBe('Pick a model');
    expect(options.slice(1).map((o) => o.textContent)).toEqual(['Alpha', 'Beta']);
    expect(options[2].disabled).toBe(true);
    expect(select.value).toBe('');
    expect(select.classList.contains('select-sm')).toBe(true);
  });
});

describe('Textarea', () => {
  it('is mono by default and picks up prose/autoGrow classes when asked', () => {
    render(<Textarea defaultValue="" />);
    expect(container.querySelector('textarea')!.className).toBe('textarea');

    render(<Textarea prose autoGrow defaultValue="" />);
    expect(container.querySelector('textarea')!.className).toBe('textarea textarea-prose textarea-autogrow');
  });
});

describe('Switch', () => {

  it('draws an aria-hidden On/Off state label and a switch-sm size class', () => {
    render(<Switch checked={false} label="Enable support-bot" onChange={noop} stateLabel size="sm" />);
    const state = container.querySelector('.switch-state')!;
    expect(state.classList.contains('overline')).toBe(true);
    expect(state.textContent).toBe('Off');
    expect(state.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.switch')!.classList.contains('switch-sm')).toBe(true);

    render(<Switch checked label="Enable support-bot" onChange={noop} stateLabel />);
    expect(container.querySelector('.switch-state')!.textContent).toBe('On');
  });
});

describe('Checkbox', () => {

  it('renders a muted description line and marks a disabled row', () => {
    render(<Checkbox label="Overwrite" description="Existing files are replaced." disabled onChange={noop} />);
    expect(container.querySelector('.checkbox-description')!.textContent).toBe('Existing files are replaced.');
    expect(container.querySelector('.checkbox-row')!.classList.contains('checkbox-row-disabled')).toBe(true);
    expect((container.querySelector('input')! as HTMLInputElement).disabled).toBe(true);
  });
});
