import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import { AgentRepo } from '../../../server/storage/agentRepo';
import { createFsAgentStore } from '../fsAgentStore';

const spec: AgentSpec = {
  name: 'ops-pipeline',
  prompt: 'Coordinate the ops pipeline.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('createFsAgentStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-fsstore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps v2-only keys (description, skills, guardrail ids) when a v1 save only changes the prompt', async () => {
    const repo = new AgentRepo(tmpDir);
    const store = createFsAgentStore(tmpDir, repo);
    const stored = {
      version: 2,
      name: 'ops-pipeline',
      model: 'mock/mock-1',
      instructions: 'old prompt',
      description: 'kept across saves',
      skills: [{ registry: 'summarizer' }],
      guardrails: [{ id: 'g9', name: 'pii' }],
    } as unknown as AgentSpecV2;
    await repo.writeSpec('ops-pipeline', stored);

    const legacy = (await store.load('ops-pipeline'))!;
    await store.save('ops-pipeline', { ...legacy, prompt: 'new prompt' });

    const after = (await repo.readSpec('ops-pipeline'))! as AgentSpecV2 & {
      description?: string;
      skills?: unknown[];
    };
    expect(after.instructions).toBe('new prompt');
    expect(after.description).toBe('kept across saves');
    expect(after.skills).toEqual([{ registry: 'summarizer' }]);
    expect(after.guardrails).toEqual([{ id: 'g9', name: 'pii' }]);
  });

  it('removes a saved entry', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    await store.remove('ops-pipeline');
    expect(await store.load('ops-pipeline')).toBeUndefined();
  });

  it('skips an unreadable file or an invalid id instead of failing the whole list', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('good', spec);
    const dir = path.join(tmpDir, '.lousho', 'agents');
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'name: [unclosed', 'utf8');
    fs.writeFileSync(path.join(dir, 'My Agent.yaml'), 'name: x\nprompt: y\nprovider: { type: mock, model: m }\n', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await store.list()).map((e) => e.id)).toEqual(['good']);
    warn.mockRestore();
  });
});
