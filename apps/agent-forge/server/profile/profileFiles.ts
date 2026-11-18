import * as fs from 'node:fs';
import type { RequestHandler } from 'express';
import * as path from 'node:path';
import { isValidAgentId } from '../../shared/agentId';
import type { AgentTarget, DeliveryOutcome } from '../../shared/profileWire';
import { WORKSPACE_ID_RE } from '../../shared/workspace';
import { sendError } from '../http/routeUtils';
import { AlreadyRunningError } from '../runRegistry';
import type { WorkspaceResolver } from '../workspace/context';

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function parseTargets(raw: unknown): AgentTarget[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return undefined;
  const targets: AgentTarget[] = [];
  for (const item of raw) {
    const { workspaceId, agentId } = (item ?? {}) as Partial<AgentTarget>;
    if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return undefined;
    if (typeof agentId !== 'string' || !isValidAgentId(agentId)) return undefined;
    targets.push({ workspaceId, agentId });
  }
  return targets;
}

export function bearerOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

export async function startTargetRun(
  resolver: WorkspaceResolver,
  target: AgentTarget,
  input: string,
  triggerId: string,
): Promise<{ outcome: DeliveryOutcome; detail?: string }> {
  const ws = await resolver.resolve(target.workspaceId);
  if (ws === undefined) return { outcome: 'missing', detail: 'Workspace not found' };
  if ((await ws.repo.readSpec(target.agentId)) === undefined) return { outcome: 'missing', detail: 'Agent not found' };
  if (!ws.triggers.isEnabled(target.agentId)) return { outcome: 'disabled', detail: 'Agent is turned off' };
  try {
    await ws.runs.run(target.agentId, input, undefined, { source: 'trigger', triggerId });
    return { outcome: 'started' };
  } catch (error) {
    if (error instanceof AlreadyRunningError) return { outcome: 'busy', detail: 'Agent is already running' };
    return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function rateLimit(max: number, windowMs = 60_000): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (hits.size > 10_000) hits.clear();
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      sendError(res, 429, 'Too many requests', 'LOUSHO_RATE_LIMITED');
      return;
    }
    next();
  };
}
