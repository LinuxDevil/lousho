import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import type { CatalogModel } from '../../../shared/wireTypes';
import type { AuthorSettings, AuthorSettingsPayload } from '../../../shared/authorWire';

const api = vi.hoisted(() => ({
  settings: {
    model: 'anthropic/claude-sonnet-5-5',
    reviewModel: 'anthropic/claude-haiku-5-5',
    reviewEnabled: true,
    ready: true,
  } as AuthorSettingsPayload,
  models: [] as CatalogModel[],
  settingsError: undefined as Error | undefined,
  catalogError: undefined as Error | undefined,
  save: null as unknown as (patch: Partial<AuthorSettings>) => Promise<AuthorSettingsPayload>,
}));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    getAuthorSettings: async () => {
      if (api.settingsError) throw api.settingsError;
      return api.settings;
    },
    catalogModels: async () => {
      if (api.catalogError) throw api.catalogError;
      return api.models;
    },
    saveAuthorSettings: (patch: Partial<AuthorSettings>) => api.save(patch),
  },
}));

import { AuthorSettingsCard } from '../AuthorSettingsCard';

/** A catalog row in the shape `GET /catalog/models` answers. */
function model(id: string, tools: boolean, available = true): CatalogModel {
  const slash = id.indexOf('/');
  return {
    id,
    provider: id.slice(0, slash),
    modelId: id.slice(slash + 1),
    capabilities: { tools, vision: false, reasoning: false, structuredOutput: false, hostedTools: [] },
    available,
    contextWindow: 128000,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  const host = render(<AuthorSettingsCard />);
  await flush();
  return host;
}

const selects = (host: HTMLElement) => [...host.querySelectorAll('select.select')] as HTMLSelectElement[];
const pill = (host: HTMLElement) => host.querySelector('.status-pill');

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  api.settings = {
    model: 'anthropic/claude-sonnet-5-5',
    reviewModel: 'anthropic/claude-haiku-5-5',
    reviewEnabled: true,
    ready: true,
  };
  api.models = [];
  api.settingsError = undefined;
  api.catalogError = undefined;
  api.save = vi.fn(async (patch: Partial<AuthorSettings>) => ({ ...api.settings, ...patch }));
});

describe('AuthorSettingsCard', () => {

  it('sends one PUT with only the changed field and updates from the response', async () => {
    api.models = [model('anthropic/claude-sonnet-5-5', true), model('openai/gpt-4.1', true)];
    const host = await mount();
    const [authorSelect] = selects(host);

    act(() => choose(authorSelect, 'openai/gpt-4.1'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith({ model: 'openai/gpt-4.1' });
    await flush();
    expect(authorSelect.value).toBe('openai/gpt-4.1');

    const toggle = host.querySelector('button[role="switch"]') as HTMLButtonElement;
    act(() => toggle.click());
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save).toHaveBeenLastCalledWith({ reviewEnabled: false });
    await flush();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('a rejected PUT shows the server error under the row and restores the old value', async () => {
    api.models = [model('anthropic/claude-sonnet-5-5', true), model('openai/gpt-4.1', true)];
    api.save = vi.fn(async () => {
      throw new Error('model must look like provider/model.');
    });
    const host = await mount();
    const [authorSelect] = selects(host);

    act(() => choose(authorSelect, 'openai/gpt-4.1'));
    await flush();
    expect(host.querySelector('.field-error')?.textContent).toBe('model must look like provider/model.');
    expect(authorSelect.value).toBe('anthropic/claude-sonnet-5-5');
    expect(authorSelect.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows "Needs a key" naming the provider, plus an Add key button, when not ready', async () => {
    api.settings = { ...api.settings, ready: false, missingKeyFor: 'anthropic' };
    const host = await mount();
    expect(pill(host)?.textContent).toContain('Needs a key');
    expect(pill(host)?.classList.contains('pill-error')).toBe(true);
    expect(pill(host)?.getAttribute('title')).toBe('Add a anthropic key in Provider keys.');
    const addKey = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add key');
    expect(addKey).toBeDefined();
  });
});
