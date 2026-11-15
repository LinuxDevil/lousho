import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import { describeMemoryProviderContract } from './providerContract';
import { defineMemory, fileMemory, inMemoryMemory, inMemoryVectorMemory, memoryKey, type MemoryProvider } from './index';
import { hashEmbedder } from '../testing/hashEmbedder';

const systemOf = (call: MockRequest | undefined): string =>
  String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);
const lastToolResult = (call: MockRequest): unknown => JSON.parse(String(call.messages.at(-1)?.content));

async function seeded(texts: string[], key = 'notes#global'): Promise<MemoryProvider> {
  const provider = inMemoryMemory();
  for (const text of texts) await provider.add(key, { text });
  return provider;
}

describe('defineMemory', () => {
  it('applies defaults and validates', () => {
    const slot = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
    expect(slot.recall).toEqual({ onSessionStart: true, maxItems: 10, query: 'none' });
    expect(slot.expose).toEqual({ remember: true, recall: true, forget: false });
    expect(Object.isFrozen(slot)).toBe(true);
    expect(() => defineMemory({ name: 'my notes', scope: 'global', provider: inMemoryMemory() })).toThrow(/invalid name/);
    expect(() => defineMemory({ name: 'n', scope: 'global', provider: undefined as never })).toThrow(/needs a provider/);
    expect(() =>
      defineMemory({ name: 'n', scope: 'global', provider: inMemoryMemory(), recall: { maxItems: 0 } })
    ).toThrow(/maxItems must be a positive integer/);
  });

  it('rejects duplicate slot names and taken tool names in createAgent', () => {
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
    expect(() => createAgent({ provider: mockModel([]), memory: [notes, notes] })).toThrow(/two memory slots are named 'notes'/);
    const taken = defineTool({ name: 'recall_notes', description: 'x', input: z.object({}), execute: () => 'x' });
    expect(() => createAgent({ provider: mockModel([]), tools: [taken], memory: [notes] })).toThrow(
      /tool named 'recall_notes' is already registered/
    );
  });
});

describe('memory tools and the recalled block', () => {

  it('recall_ returns a vector score and caps limit at 100', async () => {
    const provider = inMemoryVectorMemory({ embedder: hashEmbedder() });
    for (let i = 0; i < 120; i++) await provider.add('notes#global', { text: `fact number ${i} about tea` });
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { onSessionStart: false } });
    const model = mockModel([{ toolCalls: [{ name: 'recall_notes', args: { query: 'tea', limit: 999_999 } }] }, 'done']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');
    const { items } = lastToolResult(model.calls[1]) as { items: { score?: number; metadata?: unknown }[] };
    expect(items).toHaveLength(100);
    expect(typeof items[0].score).toBe('number');
    expect(items[0].metadata).toBeUndefined();
  });

  it('recall_ with a query that matches nothing says the slot is not empty', async () => {
    // A phrasing miss used to return `items: []` while the recalled <memory>
    // block showed items - the model concluded the memory was empty.
    const provider = inMemoryMemory();
    await provider.add('notes#global', { text: 'likes tea' });
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { onSessionStart: false } });
    const model = mockModel([{ toolCalls: [{ name: 'recall_notes', args: { query: 'zebras' } }] }, 'done']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');
    expect(lastToolResult(model.calls[1])).toMatchObject({ items: [], note: expect.stringContaining('not empty') });
  });
});

describe('memory validation', () => {
  it('rejects an invalid scope, recall.query or provider in defineMemory', () => {
    const provider = inMemoryMemory();
    expect(() => defineMemory({ name: 'n', scope: 'user' as never, provider })).toThrow(/scope must be 'global', 'session' or a function/);
    expect(() => defineMemory({ name: 'n', scope: 'global', provider, recall: { query: 'lastinput' as never } })).toThrow(
      /recall.query must be 'last-input' or 'none'/
    );
    expect(() => defineMemory({ name: 'n', scope: 'global', provider: { list: provider.list, add: provider.add } as never })).toThrow(
      /needs a provider/
    );
  });

  it('memoryKey rejects a scope function that returns a non-string or a key built from a missing value', () => {
    const slot = (scope: () => unknown) => defineMemory({ name: 'w', scope: scope as never, provider: inMemoryMemory() });
    for (const bad of [{ bad: true }, 42, '', 'user:[object Object]', 'user:undefined', 'null']) {
      expect(() => memoryKey(slot(() => bad))).toThrow(expect.objectContaining({ code: 'LOUSHO_MEMORY_INVALID' }));
    }
    expect(() =>
      memoryKey(
        slot(() => {
          throw new Error('boom');
        })
      )
    ).toThrow(/memory 'w': the scope function threw: boom/);
    expect(memoryKey(slot(() => undefined))).toBeUndefined();
    expect(memoryKey(slot(() => null))).toBeUndefined();
    expect(memoryKey(slot(() => 'user:u-1'))).toBe('w#user:u-1');
  });

  it('providers refuse a missing scope key instead of storing under "undefined"', async () => {
    const providers: MemoryProvider[] = [inMemoryMemory(), inMemoryVectorMemory({ embedder: hashEmbedder() })];
    for (const provider of providers) {
      await expect(provider.add(undefined as never, { text: 'x' })).rejects.toMatchObject({ code: 'LOUSHO_MEMORY_INVALID' });
      await expect(provider.list('' as never)).rejects.toMatchObject({ code: 'LOUSHO_MEMORY_INVALID' });
      await expect(provider.remove(undefined as never, 'id')).rejects.toMatchObject({ code: 'LOUSHO_MEMORY_INVALID' });
    }
  });
});

describe('memory recall failures', () => {
  it('a corrupt memory file does not fail the run: recall is skipped with a warning', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mem-corrupt-'));
    const provider = fileMemory({ dir });
    await provider.add('notes#global', { text: 'likes tea' });
    const [file] = await readdir(dir);
    await writeFile(path.join(dir, file), '{corrupt');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notes = defineMemory({ name: 'notes', scope: 'global', provider });
      const model = mockModel(['hi', 'again']);
      const agent = createAgent({ instructions: 'Be brief.', provider: model, memory: [notes] });
      await expect(agent.send('hello')).resolves.toMatchObject({ text: 'hi' });
      await agent.send('again');
      expect(systemOf(model.calls[0])).toBe('Be brief.');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/memory 'notes': recall failed, continuing without it/);
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createAgent({ memory })', () => {

  it('keeps the recalled block and the memory tools in a run continued after an approval', async () => {
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded(['likes tea']) });
    const send = defineTool({ name: 'send', description: 's', input: z.object({}), needsApproval: true, execute: () => 'sent' });
    const model = mockModel([{ toolCalls: [{ name: 'send' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [send], memory: [notes] });
    const paused = await agent.send('send it');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(systemOf(model.lastCall)).toContain('- likes tea');
    expect(systemOf(model.lastCall).match(/<memory/g)).toHaveLength(1);
    // The continued run binds the memory tools again, to the scope it paused with.
    expect(toolsOf(model.lastCall)).toEqual(['send', 'remember_notes', 'recall_notes']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stores a structured itemSchema as canonical JSON in text and the parsed args in metadata', async () => {
    const provider = inMemoryMemory();
    const state = defineMemory({
      name: 'state',
      scope: 'global',
      provider,
      itemSchema: z.object({ trust: z.number(), mood: z.string() }),
    });
    const model = mockModel([
      { toolCalls: [{ name: 'remember_state', args: { mood: 'playful', trust: 10 } }] },
      { toolCalls: [{ name: 'recall_state' }] },
      'done',
    ]);
    await createAgent({ provider: model, memory: [state] }).send('hi');

    const [item] = await provider.list('state#global');
    expect(item.text).toBe('{"mood":"playful","trust":10}');
    expect(item.metadata).toEqual({ mood: 'playful', trust: 10 });
    expect(lastToolResult(model.calls[1])).toEqual({ remembered: item.id });
    expect(lastToolResult(model.calls[2])).toEqual({ items: [{ id: item.id, text: item.text, createdAt: item.createdAt }] });
    expect(() => defineMemory({ name: 's', scope: 'global', provider, itemSchema: {} as never })).toThrow(/itemSchema must be a zod schema/);
  });

  // an oversized remembered item went into the system prompt of every later run, past the context window,
  // and compaction cannot remove a system message. remember_ caps item text and the injected block has a budget.
  it('an oversized remember_ is refused and the injected block stays under its budget', async () => {
    const provider = inMemoryMemory();
    const notes = defineMemory({ name: 'notes', scope: 'global', provider });
    const model = mockModel([{ toolCalls: [{ name: 'remember_notes', args: { text: 'x'.repeat(200_000) } }] }, 'done']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');

    expect(await provider.list('notes#global')).toEqual([]);

    // And the block the recall injects is capped: the oldest items are dropped.
    const seeded = inMemoryMemory();
    for (let i = 0; i < 10; i++) await seeded.add('facts#global', { text: `fact-${i}-${'y'.repeat(5_000)}` });
    const facts = defineMemory({ name: 'facts', scope: 'global', provider: seeded });
    const calls = mockModel(['ok']);
    await createAgent({ provider: calls, memory: [facts] }).send('hi');
    const system = systemOf(calls.calls[0]);
    expect(system.length).toBeLessThan(21_000);
    expect(system).toContain('<memory name="facts">');
    expect(system).not.toContain('fact-0-');
  });

  it('expose: { remember: false } hides the tool; onSessionStart: false skips recall', async () => {
    const provider = await seeded(['likes tea']);
    const notes = defineMemory({
      name: 'notes',
      scope: 'global',
      provider,
      expose: { remember: false },
      recall: { onSessionStart: false },
    });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');
    expect(toolsOf(model.lastCall)).toEqual(['recall_notes']);
    expect(systemOf(model.lastCall)).not.toContain('<memory');
  });
});

describeMemoryProviderContract('inMemoryMemory', (options) => inMemoryMemory(options));

const contractDirs: string[] = [];
afterAll(async () => {
  await Promise.all(contractDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
describeMemoryProviderContract('fileMemory', async (options) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lousho-memory-contract-'));
  contractDirs.push(dir);
  return fileMemory({ dir, ...options });
});

describe('memory providers', () => {

  it('fileMemory reads a file saved under the legacy percent-encoded name, and moves it on the next save', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lousho-memory-'));
    try {
      const provider = fileMemory({ dir });
      await provider.add('notes#user:Alice', { text: 'old note' });
      expect(await readdir(dir)).toEqual(['notes%23user%3a^alice.json']);
      await rename(path.join(dir, 'notes%23user%3a^alice.json'), path.join(dir, 'notes%23user%3AAlice.json'));

      expect((await provider.list('notes#user:Alice')).map((i) => i.text)).toEqual(['old note']);
      expect(await provider.list('notes#user:ALICE')).toEqual([]);
      await provider.add('notes#user:Alice', { text: 'new note' });
      expect(await readdir(dir)).toEqual(['notes%23user%3a^alice.json']);
      expect((await provider.list('notes#user:Alice')).map((i) => i.text)).toEqual(['new note', 'old note']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
