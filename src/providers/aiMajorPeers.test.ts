/**
 * Provider packages follow the installed `ai` major: the peer
 * ranges in package.json, the install hint of a missing provider package,
 * and which Ollama package OllamaProvider loads. The `ai` v6/v7 cases give a
 * provider the aliased real `ai-v6` / `ai-v7` module instead of the installed one.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { type AiSdkModule } from './aiSdkCompat';
import { listProviders, peerInstallCommand } from './providerSpec';

const messages = [{ role: 'user' as const, content: 'hi' }];

afterEach(() => {
  vi.doUnmock('@ai-sdk/openai');
  vi.doUnmock('ollama-ai-provider');
  vi.doUnmock('ollama-ai-provider-v2');
  vi.resetModules();
});

describe('package.json peer ranges', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const alternatives = (range: string) => range.split('||').map((part) => part.trim());

  it.each(listProviders())('covers every pairing of the $name provider package, as an optional peer', ({ peers }) => {
    for (const pairing of Object.values(peers)) {
      const declared = alternatives(manifest.peerDependencies[pairing.name]);
      expect(declared).toEqual(expect.arrayContaining(alternatives(pairing.accepts)));
      expect(manifest.peerDependenciesMeta[pairing.name]).toEqual({ optional: true });
    }
  });
});

describe('peerInstallCommand', () => {

  it('falls back to a plain install for a package that is not a provider peer', () => {
    expect(peerInstallCommand('left-pad', 7)).toBe('npm install left-pad');
  });
});

async function ollamaOn(ai: AiSdkModule) {
  const provider = new (await import('./OllamaProvider')).OllamaProvider({ name: 'ollama', maxRetries: 0 });
  Object.assign(provider, { ai });
  return provider as unknown as { createModel(id: string): Promise<unknown>; generate(o: { messages: typeof messages }): Promise<unknown> };
}

describe('the Ollama package OllamaProvider loads', () => {
  function mockOllama(packageName: string) {
    const model = vi.fn((id: string, settings?: object) => ({ id, settings }));
    const createOllama = vi.fn(() => model);
    vi.resetModules();
    vi.doMock(packageName, () => ({ createOllama }));
    return { createOllama, model };
  }

  it('ai 7: ollama-ai-provider-v2, which takes no model settings', async () => {
    const { createOllama, model } = mockOllama('ollama-ai-provider-v2');
    await (await ollamaOn(aiV7)).createModel('llama3');
    expect(createOllama).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'http://localhost:11434/api', headers: {} }));
    expect(model).toHaveBeenCalledWith('llama3');
  });
});
