import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMProviderRegistry, LLMProvider } from './llm';
import { resolveProvider } from './resolveProvider';

/** Matches an SDKError with this stable `code`. */
const withCode = (code: string) => expect.objectContaining({ code });

function fakeProvider(name: string): LLMProvider {
  return {
    name,
    generate: vi.fn(),
    stream: vi.fn(),
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  } as unknown as LLMProvider;
}

describe('resolveProvider errors', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('names the env var when the API key is missing, without reaching the registry', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create');

    expect(() => resolveProvider('openai/gpt-4o')).toThrow(
      'resolveProvider: OPENAI_API_KEY is not set. Set it in your environment, or pass a provider instance: createAgent({ provider: ... })'
    );
    expect(() => resolveProvider('openai/gpt-4o')).toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('under cassette replay resolves a spec without the key; a call that reaches it reports the missing key', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LOUSHO_EVAL_CASSETTES', 'replay');
    const fake = Object.assign(fakeProvider('openai'), { defaultModel: 'gpt-4o-mini' });
    vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fake);

    const provider = resolveProvider('openai/gpt-4o-mini');

    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBe('gpt-4o-mini');
    await expect(provider.generate({ messages: [] })).rejects.toThrow('OPENAI_API_KEY is not set');
    await expect(provider.generate({ messages: [] })).rejects.toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    await expect(provider.getModels()).rejects.toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
  });

  it('turns a dashed vendor into a valid AI SDK factory name', () => {
    expect(() => resolveProvider('cloudflare-workers-ai/llama')).toThrow("fromAiSdk(cloudflareWorkersAi('llama'))");
  });

  it.each([
    [
      'openai/gpt-4o',
      'OPENAI_API_KEY',
      'npm install @ai-sdk/openai@^0.0.42 (ai 4); npm install @ai-sdk/openai@^3.0.0 (ai 6); npm install @ai-sdk/openai@^4.0.0 (ai 7)',
    ],
  ])('tells you the npm install command for each ai major when the peer for %s is missing', (spec, envKey, hint) => {
    vi.stubEnv(envKey, 'value');
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
      throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    });

    expect(() => resolveProvider(spec)).toThrow(`Run: ${hint}`);
    expect(() => resolveProvider(spec)).toThrow(withCode('LOUSHO_PEER_MISSING'));
  });

  it.each([
    ['mistral/mistral-large-latest', 'mistral', '@ai-sdk/mistral', 'mistral-large-latest'],
  ])('resolves %s to its AI SDK package without reading a key up front', (spec, name, packageName, model) => {
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider(name));

    resolveProvider(spec);

    expect(createSpy).toHaveBeenCalledWith('ai-sdk', { name, packageName, defaultModel: model });
  });

  it.each([ 'ai-sdk/../x/m'])('rejects the malformed ai-sdk spec %s', (spec) => {
    expect(() => resolveProvider(spec)).toThrow(withCode('LOUSHO_PROVIDER_SPEC_INVALID'));
  });

  it('builds a real model from an installed AI SDK package', async () => {
    const provider = resolveProvider('ai-sdk/openai/gpt-4o-mini');
    expect(provider.name).toBe('openai');
    const model = await (provider as unknown as { createModel(id: string): Promise<{ modelId: string }> }).createModel('gpt-4o-mini');
    expect(model.modelId).toBe('gpt-4o-mini');
  });

  it.each([
    [7, '^4.0.0'],
  ] as const)('names the range of any @ai-sdk package for ai %i', async (major, range) => {
    const { peerInstallCommand } = await import('./providerSpec');
    expect(peerInstallCommand('@ai-sdk/mistral', major)).toBe(`npm install @ai-sdk/mistral@${range}`);
  });

  it('rethrows unrelated registry errors unchanged', () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => resolveProvider('openai/gpt-4o')).toThrow('boom');
  });
});
