import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOOK_TEMPLATES, templatePoint } from '../../../../hooks/hookTemplates';
import type { Graph } from '../../../../graph/v2/types';
import { HookFields } from '../HookFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template = HOOK_TEMPLATES[0]!;
const point = templatePoint(template);

function nodeWith(code: string) {
  return {
    id: 'hook-1',
    kind: 'hook',
    owner: null,
    position: { x: 0, y: 0 },
    data: { item: { id: 'h1', inline: { name: 'hook', point, code } } },
  };
}

let root: Root | undefined;
let container: HTMLDivElement;

function render(code: string) {
  const patch = vi.fn();
  const node = nodeWith(code);
  const graph = { version: 2, nodes: [node], emptySections: [], unplaced: [] } as unknown as Graph;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<HookFields node={node as never} graph={graph} patch={patch} replace={() => {}} problems={[]} />));
  return patch;
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.body.querySelector('[role="alertdialog"]');

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('HookFields template', () => {
  it('applies a template straight away when the code is empty', () => {
    const patch = render('');
    act(() => button(container, template.name).click());
    expect(dialog()).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('asks in a dialog before replacing existing code, then replaces on confirm', () => {
    const patch = render('return ctx;');
    act(() => button(container, template.name).click());
    expect(dialog()?.textContent).toContain(`Replace the current code with ${template.name}?`);
    expect(patch).not.toHaveBeenCalled();
    act(() => button(dialog()!, 'Replace code').click());
    expect(patch).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('keeps the code when cancelled', () => {
    const patch = render('return ctx;');
    act(() => button(container, template.name).click());
    act(() => button(dialog()!, 'Cancel').click());
    expect(patch).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
