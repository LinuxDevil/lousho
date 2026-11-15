/**
 * Contract tests for multimodal message parts: what each
 * 'ai'-SDK-backed provider hands the model (a mock language model of the
 * installed `ai` major, see aiShapes.testkit.ts) when a user message carries
 * image and file parts. Prompts are compared in one neutral shape on every
 * major: an image is an `image` part, a file a `file` part.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { installedAiMajor } from './aiMajor.testkit';
import { mockLanguageModel } from './aiShapes.testkit';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import type { UnsupportedFiles } from './aiSdkProvider';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// Real PDF magic bytes: `ai` 5+ sniffs the media type from the bytes, so a PNG labelled a PDF would come out an image.
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);

type Extra = { unsupportedFiles?: UnsupportedFiles };

const providers: Array<[string, (extra?: Extra) => LLMProvider]> = [
  ['openai', (extra) => new OpenAIProvider({ name: 'openai', apiKey: 'k', ...extra })],
  ['anthropic', (extra) => new AnthropicProvider({ name: 'anthropic', apiKey: 'k', ...extra })],
  ['ollama', (extra) => new OllamaProvider({ name: 'ollama', ...extra })],
  ['openrouter', (extra) => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k', ...extra })],
];

/** Point a provider at a mock model of the installed major and capture the prompts it receives. */
function withMockModel(provider: LLMProvider, supportsImageUrls = false) {
  const { model, prompts } = mockLanguageModel({ supportsImageUrls });
  const target = provider as unknown as { createModel: (id: string) => Promise<LanguageModel> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
  return { prompts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(providers)('%s provider: multimodal user content', (_name, make) => {
  it('sends text and image parts (bytes and data URL) to the model', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider);
    const messages: Message[] = [
      { role: 'system', content: 'You describe images.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', image: PNG, mimeType: 'image/png' },
          { type: 'image', image: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
        ],
      },
    ];

    // Without cache breakpoints, which the Anthropic provider adds by default (promptCaching.test.ts).
    const result = await provider.generate({ messages, promptCaching: false });

    expect(result.text).toBe('a cat');
    expect(prompts[0]).toEqual([
      { role: 'system', content: 'You describe images.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', image: PNG, mimeType: 'image/png' },
          { type: 'image', image: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' },
        ],
      },
    ]);
  });

  it('passes an image URL through to a model that takes URLs', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider, true);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'image', image: 'https://example.com/cat.png' }] }],
      promptCaching: false,
    });

    expect(prompts[0][0]).toEqual({
      role: 'user',
      content: [{ type: 'image', image: new URL('https://example.com/cat.png') }],
    });
  });

  it('rejects a file part it cannot send (ai 4, Ollama) with LOUSHO_UNSUPPORTED_CONTENT by default', async () => {
    const provider = make();
    const sendsPdf = installedAiMajor >= 6 && provider.name !== 'ollama';
    const { prompts } = withMockModel(provider);
    const file: Message = {
      role: 'user',
      content: [{ type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'report.pdf' }],
    };

    if (sendsPdf) {
      await provider.generate({ messages: [file] });
      expect(prompts[0][0]).toMatchObject({ role: 'user', content: [{ type: 'file', mimeType: 'application/pdf' }] });
      return;
    }
    await expect(provider.generate({ messages: [file] })).rejects.toMatchObject({
      code: 'LOUSHO_UNSUPPORTED_CONTENT',
      message: expect.stringContaining(`The ${provider.name} provider cannot send application/pdf file parts on ai ${installedAiMajor}`),
    });
    expect(prompts).toHaveLength(0);
  });

  it("with unsupportedFiles: 'text-note', sends a file part as a text note on ai 4 and for Ollama, with one warning per media type", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make({ unsupportedFiles: 'text-note' });
    // The installed major decides: on ai 6/7 the OpenAI, Anthropic and OpenRouter providers send a PDF.
    const sendsPdf = installedAiMajor >= 6 && provider.name !== 'ollama';
    const { prompts } = withMockModel(provider);
    const file: Message = {
      role: 'user',
      content: [{ type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'report.pdf' }],
    };

    await provider.generate({ messages: [file] });
    await provider.generate({ messages: [file] });

    if (sendsPdf) {
      expect(prompts[0][0]).toMatchObject({ role: 'user', content: [{ type: 'file', mimeType: 'application/pdf' }] });
      expect(warn).not.toHaveBeenCalled();
      return;
    }
    expect(prompts[0][0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[file report.pdf (application/pdf) not sent]' }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      `The ${provider.name} provider cannot send application/pdf file parts on ai ${installedAiMajor}; they are sent as a text note.`
    );
  });

  it('sends the text parts of assistant and system messages', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider);

    await provider.generate({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'image', image: PNG }] },
        { role: 'user', content: 'again' },
      ],
    });

    expect(prompts[0]).toMatchObject([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
  });
});
