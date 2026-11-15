import { describe, expect, it } from 'vitest';
import { listModels } from './catalog';
import { listRegisteredModels } from './registry';

describe('listModels', () => {
  it('lists every registered model once, with id "<provider>/<modelId>"', () => {
    const entries = listModels({ env: {} });
    expect(entries.length).toBe(listRegisteredModels().length);
    for (const entry of entries) {
      expect(entry.id).toBe(`${entry.provider}/${entry.modelId}`);
    }
  });
});
