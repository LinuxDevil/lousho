/**
 * Persisted trace history - a run writes the SDK's trace files under the
 * agent's folder and `GET /agents/:id/traces[/:traceId]` reads them back.
 */
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
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentRunStatusPayload, TraceDetailPayload, TraceSummaryPayload } from '../../shared/wireTypes';

const SPEC: AgentSpec = {
  name: 'trace-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

function stopped(runManager: RunManager, agentId: string): Promise<AgentRunStatusPayload> {
  if (runManager.status(agentId).status === 'done') return Promise.resolve(runManager.status(agentId));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${agentId}`)), 3000);
    const onStatus = (payload: AgentRunStatusPayload) => {
      if (payload.agentId !== agentId || payload.status !== 'done') return;
      clearTimeout(timer);
      runManager.off('status', onStatus);
      resolve(payload);
    };
    runManager.on('status', onStatus);
  });
}

describe('trace history routes', () => {
  let baseDir: string;
  let runManager: RunManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-m5b-test-'));
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function finishedRun(agentId: string, input = 'What is the weather?'): Promise<void> {
    await request(app).post(`/agents/${agentId}/run`).send({ input, spec: SPEC }).expect(202);
    await stopped(runManager, agentId);
  }

  it('GET /agents/:id/traces lists the runs newest first, without file paths', async () => {
    await finishedRun('weather');
    await finishedRun('weather', 'And tomorrow?');
    const res = await request(app).get('/agents/weather/traces').expect(200);
    const traces = (res.body as { traces: TraceSummaryPayload[] }).traces;
    expect(traces).toHaveLength(2);
    expect(traces[0].startTime).toBeGreaterThanOrEqual(traces[1].startTime);
    expect(traces[0].status).toBe('ok');
    expect(traces[0].modelCalls).toBeGreaterThan(0);
    expect(traces[0]).not.toHaveProperty('file');
    expect(JSON.stringify(res.body)).not.toContain('lou-m5b-test-');

    const limited = await request(app).get('/agents/weather/traces?limit=1').expect(200);
    expect(limited.body.traces).toHaveLength(1);
  });

  it('GET /agents/:id/traces/:traceId returns the spans with kind and status', async () => {
    await finishedRun('weather');
    const [summary] = (await request(app).get('/agents/weather/traces').expect(200)).body.traces as TraceSummaryPayload[];
    const res = await request(app).get(`/agents/weather/traces/${summary.traceId}`).expect(200);
    const body = res.body as TraceDetailPayload;
    expect(body.traceId).toBe(summary.traceId);
    const root = body.spans.find((s) => s.id === summary.traceId);
    expect(root).toMatchObject({ kind: 'internal' });
    expect(body.spans.find((s) => s.attributes['gen_ai.operation.name'] === 'chat')).toMatchObject({ kind: 'client' });
  });

  it('an agent without runs has an empty list; an unknown agent is 404', async () => {
    await request(app).put('/agents/fresh').send(SPEC).expect(204);
    expect((await request(app).get('/agents/fresh/traces').expect(200)).body).toEqual({ traces: [] });
    await request(app).get('/agents/nobody/traces').expect(404);
    await request(app).get('/agents/nobody/traces/abc').expect(404);
  });

  it('a path-like trace or agent id is 400 and never reaches the filesystem', async () => {
    await finishedRun('weather');
    for (const bad of ['..%2F..%2Fagent.yaml', '..', 'a%2Fb', 'a%5Cb', '%2E%2E', 'x.jsonl']) {
      const res = await request(app).get(`/agents/weather/traces/${bad}`);
      expect(res.status, bad).not.toBe(200);
      expect(res.status, bad).toBeLessThan(500);
    }
    await request(app).get('/agents/weather/traces/..%2F..%2Fagent.yaml').expect(400);
    await request(app).get('/agents/weather/traces/a%5Cb').expect(400);
    await request(app).get('/agents/..%2Fweather/traces').expect(400);
  });
});
