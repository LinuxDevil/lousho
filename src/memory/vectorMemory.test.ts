/** InMemoryVectorMemory, hashEmbedder, and recall by meaning in an agent run. */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { hashEmbedder, mockModel } from '../testing';
import { defineMemory, memoryKey } from './defineMemory';
import type { EmbeddingProvider } from './embeddings';
import { describeMemoryProviderContract } from './providerContract';
import { inMemoryVectorMemory, memoryVectorStore, vectorMemory } from './vectorProvider';

const embedder = hashEmbedder();
const texts = async (list: Promise<{ text: string }[]>) => (await list).map((i) => i.text);

describeMemoryProviderContract('inMemoryVectorMemory', (options) => inMemoryVectorMemory({ embedder, ...options }), { query: 'rank' });

describe('inMemoryVectorMemory', () => {

  it('skips items of another embedder when ranking, lists them, and fixes them with reindex()', async () => {
    const store = memoryVectorStore();
    const before = vectorMemory(store, { embedder: { id: 'old', embed: async (list) => list.map(() => [1, 0, 0]) } });
    await before.add('k', { text: 'Sam is vegetarian' });
    const after = vectorMemory(store, { embedder });
    await after.add('k', { text: 'Prefers dark mode' });
    await after.add('other', { text: 'Sam is vegetarian' });

    expect(await texts(after.list('k', { query: 'vegetarian' }))).toEqual([]);
    expect(await texts(after.list('k'))).toEqual(['Prefers dark mode', 'Sam is vegetarian']);

    expect(await after.reindex('k')).toBe(1);
    expect(await texts(after.list('k', { query: 'vegetarian' }))).toEqual(['Sam is vegetarian']);
    expect(await after.reindex()).toBe(0);
    expect(await texts(after.list('k'))).toEqual(['Prefers dark mode', 'Sam is vegetarian']);
  });

  it('adds nothing when embedding fails, and fails clearly on a short answer', async () => {
    const failing: EmbeddingProvider = { id: 'down', embed: async () => Promise.reject(new Error('quota')) };
    const memory = inMemoryVectorMemory({ embedder: failing });
    await expect(memory.add('k', { text: 'x' })).rejects.toThrow('quota');
    await expect(memory.add('k', { text: 'y' })).rejects.toThrow('quota');
    expect(await memory.list('k')).toEqual([]);
    const short = inMemoryVectorMemory({ embedder: { id: 'short', embed: async () => [] } });
    await expect(short.add('k', { text: 'x' })).rejects.toThrow(/returned 0 vectors for 1 texts/);
  });

  it('rejects a missing embedder and a bad maxItems', () => {
    expect(() => inMemoryVectorMemory({} as never)).toThrow(/needs an embedder/);
    expect(() => inMemoryVectorMemory({ embedder, maxItems: 0 })).toThrow(/maxItems/);
  });
});

describe('semantic recall in a run', () => {
  it('puts the most relevant item first in the memory block and says so in the recall tool', async () => {
    const provider = inMemoryVectorMemory({ embedder, minScore: 0 });
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { query: 'last-input', maxItems: 3 } });
    for (const text of ['The office is in Oslo', 'Sam is vegetarian food lover', 'Prefers dark mode'])
      await provider.add(memoryKey(notes)!, { text });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('vegetarian food');
    const system = String(model.lastCall?.messages.find((m) => m.role === 'system')?.content);
    expect(system).toContain('<memory name="notes">\n- Sam is vegetarian food lover\n');
    expect(model.lastCall?.tools?.map((t) => t.function.name)).toContain('recall_notes');
    expect(model.lastCall?.tools?.find((t) => t.function.name === 'recall_notes')?.function.description).toContain('by meaning, most relevant first');
  });
});
