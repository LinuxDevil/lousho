import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { runCandidate } from '../evals/candidateRun';
import { buildServeAgent } from '../serve/serveRoutes';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { configureStudioHome } from '../workspace/studioPaths';
import type { WorkspaceContext } from '../workspace/context';

const FLOW_SPEC = {
  version: 2,
  name: 'flowy',
  model: 'mock/mock-1',
  instructions: 'Run the flow.',
  flow: { code: 'flowy', name: 'Flowy', flow: { type: 'return', value: 'ok' } },
} as unknown as AgentSpecV2;

describe('flow agents where flows are not supported', () => {
  let baseDir: string;
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  function stores() {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lou-flow-guard-')));
    const paths = configureStudioHome(path.join(baseDir, '.lousho'));
    return { secretsStore: new SecretsStore(paths), settings: new SettingsStore(paths), spendLog: new SpendLog(paths.spend) };
  }

  it('an eval example for a flow agent fails with a clear error', async () => {
    const { secretsStore, settings } = stores();
    const result = await runCandidate(FLOW_SPEC, 'hi', new AbortController().signal, {
      agentId: 'flowy',
      baseDir,
      secretsStore,
      settings,
    });
    expect(result.error).toBe('Flow agents cannot be evaluated yet.');
  });

  it('serving a flow agent fails with a clear error', async () => {
    const services = stores();
    const workspace = { ref: { root: baseDir } } as unknown as WorkspaceContext;
    await expect(buildServeAgent(FLOW_SPEC, 'flowy', workspace, services)).rejects.toThrow('Flow agents cannot be served yet.');
  });
});
