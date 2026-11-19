import type { Express } from 'express';
import { AgentRepo } from './storage/agentRepo';
import { asyncRoute } from './http/routeUtils';
import { listAgentTraces } from './traceStore';
import { FileChatStore } from './chatStore';
import { groupRunsByChat } from '../shared/chatRuns';
import type { RunListRow } from '../shared/wireTypes';
import type { WorkspaceContext } from './workspace/context';
import type { WorkspaceRegistry } from './workspace/workspaceRegistry';

export interface RunsListDeps {
  registry: WorkspaceRegistry;
  warm: () => WorkspaceContext[];
}

const PER_AGENT = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

async function workspaceRuns(ref: { id: string; name: string; root: string }, ctx: WorkspaceContext | undefined): Promise<RunListRow[]> {
  const repo = ctx?.repo ?? new AgentRepo(ref.root);
  const chatStore = new FileChatStore(ref.root);
  const rows: RunListRow[] = [];
  for (const agentId of repo.listIds()) {
    const agentName = (await repo.readSpec(agentId))?.name ?? agentId;
    const status = ctx?.runs.status(agentId);
    const live = status && (status.status === 'running' || status.status === 'paused') ? status : undefined;
    const liveChat = live ? (live.sessionId ?? agentId) : undefined;
    const traces = await listAgentTraces(ref.root, agentId, PER_AGENT).catch(() => []);
    const groups = groupRunsByChat(agentId, chatStore.list(agentId), traces);
    if (live !== undefined && liveChat !== undefined && !groups.some((g) => g.chatId === liveChat)) {
      const now = Date.parse(live.updatedAt);
      groups.unshift({ chatId: liveChat, preview: '', messageCount: 0, startTime: now, lastActivity: now, status: 'empty', turns: 0, inputTokens: 0, outputTokens: 0, traces: [] });
    }
    for (const g of groups) {
      const on = g.chatId === liveChat ? live : undefined;
      rows.push({
        workspaceId: ref.id,
        workspaceName: ref.name,
        agentId,
        agentName,
        chatId: g.chatId,
        preview: g.preview,
        turns: g.turns,
        status: on ? (on.status === 'running' ? 'running' : 'paused') : g.status === 'error' ? 'error' : 'ok',
        live: on !== undefined,
        startTime: g.startTime,
        lastActivity: on ? Math.max(g.lastActivity, Date.parse(on.updatedAt)) : g.lastActivity,
        ...(g.traces[0] !== undefined && { traceId: g.traces[0].traceId }),
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        ...(g.costUsd !== undefined && { costUsd: g.costUsd }),
        ...((on?.source ?? g.source) !== undefined && { source: on?.source ?? g.source }),
        ...((on?.triggerId ?? g.triggerId) !== undefined && { triggerId: on?.triggerId ?? g.triggerId }),
        ...(on?.bypass === true && { bypass: true }),
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
  rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
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
