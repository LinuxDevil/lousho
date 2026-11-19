import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { groupRunsByChat } from '../../shared/chatRuns';
import type { TraceSummaryPayload } from '../../shared/wireTypes';

const SPEC: AgentSpecV2 = { version: 2, name: 'chatty', model: 'mock/mock-1', instructions: 'You are a test agent.' };

function manager(baseDir: string): RunManager {
  return new RunManager({
    baseDir,
    checkpointStore: new FileCheckpointStore(baseDir),
    approvalStore: new FileApprovalStore(baseDir),
    host: newTestHost(baseDir),
    loadSpec: async () => SPEC,
    saveSpec: async () => {},
  });
}

async function done(rm: RunManager, agentId: string): Promise<void> {
  const start = Date.now();
  while (rm.status(agentId).status === 'running' || rm.status(agentId).status === 'idle') {
    if (Date.now() - start > 5000) throw new Error('run never settled');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const trace = (traceId: string, startTime: number, conversationId?: string, status: 'ok' | 'error' = 'ok'): TraceSummaryPayload => ({
  traceId,
  name: 'invoke_agent a',
  startTime,
  durationMs: 10,
  status,
  modelCalls: 1,
  toolCalls: 0,
  inputTokens: 5,
  outputTokens: 5,
  ...(conversationId !== undefined && { conversationId }),
});

describe('groupRunsByChat', () => {
  it('carries the chat trigger onto its group', () => {
    const [group] = groupRunsByChat('a', [{ sessionId: 'a', startedAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString(), messageCount: 1, preview: 'p', source: 'trigger', triggerId: 'nightly' }], []);
    expect(group).toMatchObject({ source: 'trigger', triggerId: 'nightly' });
  });

  it('puts each trace in its chat, untagged ones in the agent-id chat, newest activity first', () => {
    const groups = groupRunsByChat(
      'a',
      [
        { sessionId: 'a', startedAt: new Date(0).toISOString(), updatedAt: new Date(100).toISOString(), messageCount: 4, preview: 'first' },
        { sessionId: 'c2', startedAt: new Date(200).toISOString(), updatedAt: new Date(300).toISOString(), messageCount: 2, preview: 'second' },
      ],
      [trace('t1', 10), trace('t2', 50, 'a', 'error'), trace('t3', 250, 'c2'), trace('t4', 400, 'fork-1')]
    );
    expect(groups.map((g) => [g.chatId, g.turns, g.status])).toEqual([
      ['fork-1', 1, 'ok'],
      ['c2', 1, 'ok'],
      ['a', 2, 'error'],
    ]);
    expect(groups[2]?.traces.map((t) => t.traceId)).toEqual(['t2', 't1']);
    expect(groups[2]?.inputTokens).toBe(10);
  });
});

describe('chats as runs', () => {
  let baseDir: string;
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  it('runs a new chat in its own session and continues an old chat after reopening it', async () => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-chats-')));
    const rm = manager(baseDir);
    await rm.sendMessage('chatty', 'hello one', SPEC);
    await done(rm, 'chatty');
    expect(rm.status('chatty').sessionId).toBe('chatty');

    const second = rm.newChat('chatty');
    await rm.sendMessage('chatty', 'hello two', SPEC);
    await done(rm, 'chatty');
    expect(rm.status('chatty').sessionId).toBe(second.sessionId);
    expect(second.sessionId).not.toBe('chatty');

    const reopened = rm.openChat('chatty', 'chatty');
    expect(reopened.messages.map((m) => m.content)).toContain('hello one');
    await rm.sendMessage('chatty', 'back again', SPEC);
    await done(rm, 'chatty');
    expect(rm.status('chatty').sessionId).toBe('chatty');
    const user = rm.chatState('chatty').messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(user).toEqual(['hello one', 'back again']);

    const restarted = manager(baseDir);
    expect(restarted.chatState('chatty').sessionId).toBe('chatty');
  });

  it('persists the run setup and trigger with the chat so they survive a restart and a reopen', async () => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-chats-')));
    const rm = manager(baseDir);
    await rm.run('chatty', 'go', SPEC, { source: 'trigger', triggerId: 'nightly' });
    await done(rm, 'chatty');

    const record = rm.loadChatSession('chatty', 'chatty');
    expect(record?.setup).toMatchObject({ accounts: expect.any(Array), declared: expect.any(Array), mcpServers: expect.any(Array), skipped: expect.any(Array) });
    expect(record).toMatchObject({ source: 'trigger', triggerId: 'nightly' });
    expect(rm.listChats('chatty')[0]).toMatchObject({ source: 'trigger', triggerId: 'nightly' });

    const restarted = manager(baseDir);
    expect(restarted.loadChatSession('chatty', 'chatty')?.setup).toEqual(record?.setup);
    const fresh = restarted.newChat('chatty');
    expect(restarted.loadChatSession('chatty', fresh.sessionId)?.setup).toBeUndefined();
    restarted.openChat('chatty', 'chatty');
    await restarted.sendMessage('chatty', 'again', SPEC);
    await done(restarted, 'chatty');
    expect(restarted.loadChatSession('chatty', 'chatty')?.source).toBeUndefined();
    expect(restarted.loadChatSession('chatty', 'chatty')?.setup).toBeDefined();
  });
});
