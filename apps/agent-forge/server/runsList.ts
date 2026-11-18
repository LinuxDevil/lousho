import type { Express } from 'express';
import { AgentRepo } from './storage/agentRepo';
import { asyncRoute } from './http/routeUtils';
import { listAgentTraces } from './traceStore';
import type { RunListRow } from '../shared/wireTypes';
import type { WorkspaceContext } from './workspace/context';
import type { WorkspaceRegistry } from './workspace/workspaceRegistry';

export interface RunsListDeps {
  registry: WorkspaceRegistry;
  warm: () => WorkspaceContext[];
}

const PER_AGENT = 20;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

async function workspaceRuns(ref: { id: string; name: string; root: string }, ctx: WorkspaceContext | undefined): Promise<RunListRow[]> {
  const repo = ctx?.repo ?? new AgentRepo(ref.root);
  const rows: RunListRow[] = [];
  for (const agentId of repo.listIds()) {
    const agentName = (await repo.readSpec(agentId))?.name ?? agentId;
    const base = { workspaceId: ref.id, workspaceName: ref.name, agentId, agentName };
    const status = ctx?.runs.status(agentId);
    const live = status && (status.status === 'running' || status.status === 'paused') ? status : undefined;
    if (live) {
      rows.push({
        ...base,
        status: live.status === 'running' ? 'running' : 'paused',
        live: true,
        startTime: Date.parse(live.updatedAt),
        ...(live.traceId !== undefined && { traceId: live.traceId }),
        ...(live.source !== undefined && { source: live.source }),
        ...(live.triggerId !== undefined && { triggerId: live.triggerId }),
        ...(live.bypass === true && { bypass: true }),
      });
    }
    const traces = await listAgentTraces(ref.root, agentId, PER_AGENT).catch(() => []);
    for (const trace of traces) {
      if (live?.traceId === trace.traceId) continue;
      rows.push({
        ...base,
        status: trace.status,
        live: false,
        traceId: trace.traceId,
        startTime: trace.startTime,
        durationMs: trace.durationMs,
        modelCalls: trace.modelCalls,
        toolCalls: trace.toolCalls,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        ...(trace.costUsd !== undefined && { costUsd: trace.costUsd }),
      });
    }
  }
  return rows;
}

export async function listAllRuns(deps: RunsListDeps, limit: number): Promise<RunListRow[]> {
  const refs = await deps.registry.list();
  const warm = new Map(deps.warm().map((ctx) => [ctx.ref.id, ctx]));
  const rows: RunListRow[] = [];
  for (const ref of refs) {
    try {
      rows.push(...(await workspaceRuns(ref, warm.get(ref.id))));
    } catch (error) {
      console.warn(`[lousho studio] skipping workspace '${ref.id}' in the runs list: ${(error as Error).message}`);
    }
  }
  rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.startTime ?? 0) - (a.startTime ?? 0));
  return rows.slice(0, limit);
}

export function registerRunsListRoute(app: Express, deps: RunsListDeps): void {
  app.get(
    '/runs',
    asyncRoute(async (req, res) => {
      const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
      res.json({ runs: await listAllRuns(deps, limit) });
    })
  );
}
