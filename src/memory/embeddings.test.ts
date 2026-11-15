/**
 * AiSdkEmbedder over a fake AI SDK embedding model, on the installed
 * `ai` and on the aliased `ai` 6 and 7 (each with the model spec version that
 * pairs with it).
 */
import { describe, expect, it } from 'vitest';
import * as aiV6 from 'ai-v6';
import * as aiV7 from 'ai-v7';
import { ConfigurationError } from '../execution/errors';
import { installedAiMajor } from '../providers/aiMajor.testkit';
import { aiSdkEmbedder, createAiSdkEmbedder, type AiEmbedModule } from './embeddings';

const SPEC = { 4: 'v1', 6: 'v3', 7: 'v3' } as const;

/** An embedding model whose vector for a text is `[text length, batch call number]`. */
function fakeModel(spec: string, extra: Record<string, unknown> = {}) {
  const batches: string[][] = [];
  const signals: unknown[] = [];
  const model = {
    specificationVersion: spec,
    provider: 'fake.provider',
    modelId: 'fake-embed',
    maxEmbeddingsPerCall: 1000,
    supportsParallelCalls: false,
    async doEmbed({ values, abortSignal }: { values: string[]; abortSignal?: AbortSignal }) {
      signals.push(abortSignal);
      batches.push([...values]);
      return { embeddings: values.map((v) => [v.length, batches.length]), usage: { tokens: values.length }, warnings: [] };
    },
    ...extra,
  };
  return { model, batches, signals };
}

const majors: Array<[number, () => Promise<AiEmbedModule>]> = [
  [installedAiMajor, async () => (await import('ai')) as unknown as AiEmbedModule],
  [6, async () => aiV6 as unknown as AiEmbedModule],
  [7, async () => aiV7 as unknown as AiEmbedModule],
];

describe.each(majors)('aiSdkEmbedder on ai %i', (major, loadAi) => {
  const spec = SPEC[major as 4 | 6 | 7];

  it('batches by maxBatch, keeps the order and uses the model as default id', async () => {
    const { model, batches } = fakeModel(spec);
    const embedder = createAiSdkEmbedder(model, { maxBatch: 2 }, loadAi);
    expect(embedder.id).toBe('fake.provider:fake-embed');
    const vectors = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(batches).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(vectors.map((v) => v[1])).toEqual([1, 1, 2, 2, 3]);
  });

  it('makes no call for no texts', async () => {
    const { model, batches } = fakeModel(spec);
    expect(await createAiSdkEmbedder(model, {}, loadAi).embed([])).toEqual([]);
    expect(batches).toEqual([]);
  });
});

describe('aiSdkEmbedder', () => {

  it.each([
    ['a language model', { modelId: 'gpt', doGenerate: () => undefined }, /language model/],
  ])('rejects %s with a ConfigurationError', (_label, model, message) => {
    expect(() => aiSdkEmbedder(model)).toThrow(ConfigurationError);
    expect(() => aiSdkEmbedder(model)).toThrow(message);
  });
});
