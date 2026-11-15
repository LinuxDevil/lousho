import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorSessionNotFoundError, AuthorSessionStore, titleFromText } from '../sessionStore';
import {
  type AuthorMessage,
  type AuthorSession,
  type AuthorUserMessage,
} from '../../../shared/authorWire';

/**
 * AuthorSessionStore: one JSON file per Author chat session under the
 * Studio-global sessions directory (studioPaths().sessions). The store is
 * what every later Author piece (turn runner, save gate, history) reads
 * and writes through, so this pins the file layout, the title derivation
 * and the serialized read-modify-write.
 */
describe('AuthorSessionStore', () => {
  let sessionsDir: string;
  let store: AuthorSessionStore;

  const WORKSPACE_ID = 'ws-test-abc123';

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa01-sessions-'));
    store = new AuthorSessionStore(sessionsDir);
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function userMessage(text: string, id = `m_${Math.random().toString(36).slice(2)}`): AuthorUserMessage {
    return { id, role: 'user', text, at: new Date().toISOString() };
  }

  function appendMessage(message: AuthorMessage) {
    return (s: AuthorSession): AuthorSession => ({ ...s, transcript: [...s.transcript, message] });
  }

  function sessionFiles(): string[] {
    return fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  }

  it('list returns summaries newest updatedAt first and skips unreadable files', async () => {
    const first = await store.create(undefined, WORKSPACE_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create({ mode: 'edit', agentId: 'bot' }, WORKSPACE_ID);
    await store.update(second.id, appendMessage(userMessage('hello')));
    fs.writeFileSync(path.join(sessionsDir, 'corrupt.json'), 'not json at all');

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0]).toEqual({
      id: second.id,
      title: 'hello',
      focus: { mode: 'edit', agentId: 'bot' },
      workspaceId: WORKSPACE_ID,
      updatedAt: (await store.get(second.id))?.updatedAt,
      messageCount: 1,
      createdAgentIds: [],
    });
    expect(list[1].messageCount).toBe(0);
  });

  it('update throws AuthorSessionNotFoundError for a missing session (bad ids included)', async () => {
    await expect(store.update('as_0000000000000000', appendMessage(userMessage('x')))).rejects.toBeInstanceOf(
      AuthorSessionNotFoundError
    );
    await expect(store.update('..', appendMessage(userMessage('x')))).rejects.toBeInstanceOf(
      AuthorSessionNotFoundError
    );
  });

  it('remove deletes the file once and reports false afterwards / for bad ids', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    expect(await store.remove(session.id)).toBe(true);
    expect(await store.get(session.id)).toBeUndefined();
    expect(await store.remove(session.id)).toBe(false);
    expect(await store.remove('..')).toBe(false);
    expect(sessionFiles()).toEqual([]);
  });
});

describe('titleFromText', () => {

  it('cuts at 60 chars on a word boundary and appends an ellipsis', () => {
    const sentence = 'Please build me an agent that triages every single inbound support ticket daily';
    const title = titleFromText(sentence);
    expect(sentence.length).toBeGreaterThan(60);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title.slice(0, -1)).not.toContain('  ');
  });
});
