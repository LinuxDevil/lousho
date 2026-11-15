import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';

const OPENAI_SPEC: AgentSpec = {
  name: 'needs-key',
  prompt: 'You are a helpful agent.',
  provider: { type: 'openai', model: 'gpt-4o-mini' },
};

/**
 * With no API key the studio used to run the mock provider and
 * answer "This is a mock response." - the only hint was a log line.
 */
describe('a real provider with no key', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let runManager: RunManager;
  const savedKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dui-f4-'));
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const secretsStore = new SecretsStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir, secretsStore),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
      secretsStore,
    });
    app = createApp({ agentStore, runManager, baseDir, secretsStore });
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('Chat answers 422 and takes the unsent message back out of the transcript', async () => {
    await request(app).put('/agents/a2').send(OPENAI_SPEC).expect(204);
    const res = await request(app).post('/agents/a2/message').send({ message: 'hello?' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No API key for provider 'openai'/);
    expect(runManager.chatState('a2').messages).toEqual([]);
  });
});
