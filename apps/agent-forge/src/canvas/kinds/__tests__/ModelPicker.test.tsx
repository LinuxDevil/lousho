import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ModelPicker } from '../agent/ModelPicker';
import type { CatalogState } from '../../useCatalog';
import type { CatalogModel } from '../../../../shared/wireTypes';

const catalog = vi.hoisted(() => {
  const MODELS: CatalogModel[] = [
    {
      id: 'openai/gpt-5',
      modelId: 'gpt-5',
      provider: 'openai',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: true,
    },
    {
      id: 'anthropic/claude-sonnet-5-5',
      modelId: 'claude-sonnet-5-5',
      provider: 'anthropic',
      contextWindow: 200_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: false,
    },
  ];
  return {
    MODELS,
    state: { data: MODELS, error: undefined, loading: false } as CatalogState<CatalogModel[]>,
    refresh: vi.fn(),
  };
});

const MODELS = catalog.MODELS;

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: catalog.refresh,
}));

let container: HTMLDivElement;

function render(props: { value?: string; onChange?: (value: string | undefined) => void } = {}) {
  container = mount(<ModelPicker id="node-agent-model" value={props.value} onChange={props.onChange ?? vi.fn()} />);
}

const select = () => container.querySelector('select') as HTMLSelectElement;
const input = () => container.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  catalog.state = { data: MODELS, error: undefined, loading: false };
});

describe('ModelPicker', () => {

  it('keeps the dropdown for a value not in the catalog, listing it as the current choice plus the hint', () => {
    render({ value: 'custom/my-model' });
    expect(select()!.value).toBe('custom/my-model');
    expect(select()!.textContent).toContain('custom/my-model (not in catalog)');
    expect(container.textContent).toContain('Not in the catalog. It will still be tried.');
  });

  it('renders a free-text input and a Retry button on catalog error', () => {
    catalog.state = { data: undefined, error: 'offline', loading: false };
    render({ value: 'openai/gpt-5' });
    expect(input()).not.toBeNull();
    expect(container.textContent).toContain('offline');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(catalog.refresh).toHaveBeenCalledWith('models');
  });
});
