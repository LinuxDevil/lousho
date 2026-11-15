/**
 * Tool search, offline with mockModel. Each test reads the tool names of
 * every model call (`model.calls[i].tools`) to see what was offered when.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { mockModel, type MockModel } from '../testing';
import type { Message } from '../providers';
import { loadedToolNames, visibleTools } from './toolDeferral';

afterEach(() => {
  vi.restoreAllMocks();
});

const names = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const searchFor = (query: string, id = 'call_search') => ({ toolCalls: [{ name: 'tool_search', args: { query }, id }] });

/** A small tool with a fixed result. */
function tool(name: string, description: string, options: { deferLoading?: boolean; needsApproval?: boolean } = {}): DefinedTool {
  return defineTool({ name, description, input: z.object({ amount: z.number().optional() }), execute: async () => ({ tool: name }), ...options });
}

/** Five deferred tools and one that is always sent. */
function catalog(options: { approval?: boolean } = {}): DefinedTool[] {
  return [
    tool('send_email', 'Send an email'),
    tool('get_weather', 'Get the weather forecast for a city', { deferLoading: true }),
    tool('convert_currency', 'Convert an amount of money from one currency to another', { deferLoading: true, needsApproval: options.approval }),
    tool('lookup_stock', 'Look up the price of a stock', { deferLoading: true }),
    tool('exchange_rates', 'List currency exchange rates', { deferLoading: true }),
    tool('translate_text', 'Translate text to another language', { deferLoading: true }),
  ];
}

const always = { thresholdPercent: 0 };

describe('tool search: deferral', () => {

  it('a custom search that throws is a tool error and loads nothing', async () => {
    const model = mockModel([searchFor('anything'), 'Done.']);
    const search = () => {
      throw new Error('index offline');
    };
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: { thresholdPercent: 0, search } });
    const result = await agent.send('x');
    const message = result.messages.find((m) => m.toolCallId === 'call_search');
    expect(message?.isError).toBe(true);
    expect(message?.content).toContain('tool_search failed: index offline');
    expect(names(model, 1)).toEqual(['send_email', 'tool_search']);
  });

  it('a user tool named tool_search is refused when deferral applies (and allowed when it does not)', async () => {
    const own = tool('tool_search', 'My own search');
    const deferred = createAgent({ provider: mockModel(['Hi.']), tools: [...catalog(), own], toolSearch: always });
    await expect(deferred.send('x')).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringContaining("a tool named 'tool_search' is already registered") });
    const plain = createAgent({ provider: mockModel(['Hi.']), tools: [...catalog(), own] });
    await expect(plain.send('x')).resolves.toMatchObject({ text: 'Hi.' });
  });

  it('invalid toolSearch options are refused when the agent is created', () => {
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { thresholdPercent: 2 } })).toThrow(/'toolSearch.thresholdPercent' must be a number from 0 to 1/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { maxResults: 0 } })).toThrow(/'toolSearch.maxResults' must be a whole number >= 1/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { contextWindow: -1 } })).toThrow(/'toolSearch.contextWindow' must be a positive number/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: 'auto' as never })).toThrow(/'toolSearch' must be false or an object/);
  });
});

describe('tool search: what is loaded persists through the transcript', () => {

  it('a compaction that prunes the tool_search result unloads its tools; the model can search again', async () => {
    const model = mockModel([searchFor('weather'), { toolCalls: [{ name: 'get_weather', args: {}, id: 'call_weather' }] }, 'Sunny.']);
    const agent = createAgent({
      provider: model,
      tools: catalog(),
      toolSearch: always,
      compaction: { thresholdPercent: 0.01, contextWindow: 100, protectedTokens: 1 },
    });
    const result = await agent.send('Weather in Paris?');
    // Step 2: the result is new (after the last assistant turn), so it is kept and the tool is loaded.
    expect(names(model, 1)).toEqual(['send_email', 'get_weather', 'tool_search']);
    // Step 3: the search result was pruned, so get_weather is withheld again.
    expect(model.calls[2].messages.find((m) => m.toolCallId === 'call_search')?.content).toMatch(/^\[pruned: tool_search\(/);
    expect(names(model, 2)).toEqual(['send_email', 'tool_search']);
    expect(result.text).toBe('Sunny.');
  });

  it('loadedToolNames() ignores error results, unknown names and results before the last handoff', () => {
    const deferred = new Set(['a', 'b', 'c']);
    const search = (id: string, loaded: string[], extra: Partial<Message> = {}): Message => ({
      role: 'tool',
      toolName: 'tool_search',
      toolCallId: id,
      content: JSON.stringify({ loaded: loaded.map((name) => ({ name, description: '' })), more: 0 }),
      ...extra,
    });
    expect([...loadedToolNames([search('1', ['a', 'zzz']), search('2', ['b'], { isError: true })], deferred)]).toEqual(['a']);
    const handedOff: Message[] = [search('1', ['a']), { role: 'tool', toolCallId: 'h', content: '{}', metadata: { handoff: { from: 'x', to: 'y' } } }, search('2', ['c'])];
    expect([...loadedToolNames(handedOff, deferred)]).toEqual(['c']);
    const all = [{ type: 'function' as const, function: { name: 'a', description: '', parameters: {} } }];
    expect(visibleTools(all, [], undefined)).toBe(all);
  });
});

describe('tool search: unknown model context window', () => {
  it('warns once when the model is unknown to the registry; silent with an explicit contextWindow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const unknown = mockModel(['Hi.', 'Again.'], { defaultModel: 'audit-x2-local-7b' });
      const agent = createAgent({ provider: unknown, tools: catalog(), toolSearch: always });
      await agent.send('hi');
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toContain('audit-x2-local-7b');
      expect(text).toContain('128,000');
      expect(text).toContain('registerModel');

      // Once per (feature, model) - the second run does not warn again.
      await agent.send('hi again');
      expect(warn).toHaveBeenCalledTimes(1);

      // An explicit contextWindow answers the lookup - no warning.
      const explicit = mockModel(['Hi.'], { defaultModel: 'audit-x2-local-7b' });
      await createAgent({ provider: explicit, tools: catalog(), toolSearch: { ...always, contextWindow: 8_192 } }).send('hi');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
