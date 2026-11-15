/**
 * Sessions (multi-turn conversations) for createAgent().
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import { FileSessionStore, MemorySessionStore, type SessionStore } from './index';
import { providerValidPrefix } from './AgentSession';

describe('AgentSession', () => {

  it('a turn that loses the commit race keeps the tool calls that ran, then fails LOUSHO_SESSION_BUSY', async () => {
    const inner = new MemorySessionStore();
    const wrap = (): SessionStore => ({
      load: (id) => inner.load(id),
      save: (id, messages) => inner.save(id, messages),
      delete: (id) => inner.delete(id),
    });
    let emails = 0;
    const sendEmail = defineTool({
      name: 'send_email',
      description: 'send email',
      input: z.object({}),
      execute: async () => {
        emails++;
        // Another process commits a turn while this one's tool runs.
        await agent.session({ id: 'u2', store: wrap() }).send('hi');
        return 'sent';
      },
    });
    const reply = (r: MockRequest) => {
      const last = r.messages.at(-1);
      if (last?.role === 'tool') return 'Email sent.';
      return String(last?.content).includes('email') ? { toolCalls: [{ name: 'send_email', id: 'call_1', args: {} }] } : 'hello';
    };
    const agent = createAgent({ provider: mockModel([reply], { onExhausted: 'repeat-last' }), tools: [sendEmail] });

    await expect(agent.session({ id: 'u2', store: wrap() }).send('email my boss')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });

    expect(emails).toBe(1);
    const stored = (await inner.load('u2'))!;
    // The other writer's turn, then this turn up to the tool result: the email that was sent is in the transcript.
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool']);
    expect(stored.map((m) => m.content).slice(0, 3)).toEqual(['hi', 'hello', 'email my boss']);
    expect(stored[4]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(providerValidPrefix(stored)).toHaveLength(stored.length);
  });

  describe('FileSessionStore', () => {

    it('refuses path traversal ids and treats missing sessions as empty', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
      try {
        const store = new FileSessionStore(join(dir, 'nested'));
        await expect(store.load('../x')).rejects.toThrow(/Invalid session id/);
        await expect(store.save('a/b', [])).rejects.toThrow(/Invalid session id/);
        await expect(store.delete('..')).rejects.toThrow(/Invalid session id/);
        expect(await store.load('missing')).toBeUndefined();
        await store.delete('missing');
        await store.save('ok', [{ role: 'user', content: 'x' }]);
        await store.delete('ok');
        expect(await store.load('ok')).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
