import type { Express } from 'express';
import {
  MCP_CONNECTOR_NAME,
  mcpConnectorUrlProblem,
  mcpTokenSecret,
  type McpConnectRequest,
  type McpConnectorStatus,
  type StoredMcpConnector,
} from '../../shared/profileWire';
import type { McpServerSpecV2 } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
import type { McpProbeResult } from '../routes/mcpProbe';
import { readJson, writeJson } from './profileFiles';

interface McpMeta {
  url: string;
  hasToken: boolean;
  connectedAt: string;
  verifiedAt?: string;
  error?: string;
  toolCount?: number;
}

type MetaFile = Record<string, unknown> & { mcp?: Record<string, McpMeta> };

export type McpProbe = (server: McpServerSpecV2) => Promise<McpProbeResult>;

class McpConnectorError extends Error {}

const NOT_FOUND = 'Unknown MCP connector';

const bearer = (token: string) => (/^bearer\s/i.test(token) ? token : `Bearer ${token}`);

export class McpConnectorService {
  constructor(
    private readonly file: string,
    private readonly secrets: SecretsStore,
    private readonly probe: McpProbe,
  ) {}

  private all(): Record<string, McpMeta> {
    return readJson<MetaFile>(this.file, {}).mcp ?? {};
  }

  private save(mcp: Record<string, McpMeta>): void {
    writeJson(this.file, { ...readJson<MetaFile>(this.file, {}), mcp });
  }

  private statusOf(name: string, meta: McpMeta): McpConnectorStatus {
    return {
      name,
      url: meta.url,
      hasToken: meta.hasToken && this.secrets.getSecret(mcpTokenSecret(name)) !== undefined,
      connectedAt: meta.connectedAt,
      ...(meta.verifiedAt !== undefined && { verifiedAt: meta.verifiedAt }),
      ...(meta.error !== undefined && { error: meta.error }),
      ...(meta.toolCount !== undefined && { toolCount: meta.toolCount }),
    };
  }

  list(): McpConnectorStatus[] {
    return Object.entries(this.all())
      .map(([name, meta]) => this.statusOf(name, meta))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  stored(): StoredMcpConnector[] {
    return this.list().map(({ name, url, hasToken }) => ({ name, url, ...(hasToken && { tokenSecret: mcpTokenSecret(name) }) }));
  }

  private async check(url: string, authorization: string | undefined): Promise<number> {
    const server = { url, ...(authorization !== undefined && { headers: { Authorization: authorization } }) } as McpServerSpecV2;
    const result = await this.probe(server);
    if (result.ok) return result.tools.length;
    throw new McpConnectorError(authorization === undefined ? result.error : result.error.split(authorization).join('***'));
  }

  async connect(name: string, request: McpConnectRequest): Promise<McpConnectorStatus> {
    if (!MCP_CONNECTOR_NAME.test(name)) throw new McpConnectorError('The name must be 1-32 lowercase letters, digits or dashes, starting with a letter.');
    const rawUrl = typeof request.url === 'string' ? request.url.trim() : '';
    const problem = mcpConnectorUrlProblem(rawUrl);
    if (problem !== undefined) throw new McpConnectorError(problem);
    const url = new URL(rawUrl).toString();
    const secret = mcpTokenSecret(name);
    const typed = typeof request.token === 'string' ? request.token.trim() : '';
    const existing = this.all()[name];
    const header = typed !== '' ? bearer(typed) : existing?.hasToken === true ? this.secrets.getSecret(secret) : undefined;
    const toolCount = await this.check(url, header);
    if (header !== undefined) this.secrets.setSecret(secret, header);
    else this.secrets.removeSecret(secret);
    const now = new Date().toISOString();
    const meta: McpMeta = { url, hasToken: header !== undefined, connectedAt: existing?.connectedAt ?? now, verifiedAt: now, toolCount };
    this.save({ ...this.all(), [name]: meta });
    return this.statusOf(name, meta);
  }

  async verifyNow(name: string): Promise<McpConnectorStatus> {
    const previous = this.all()[name];
    if (previous === undefined) throw new McpConnectorError(NOT_FOUND);
    const now = new Date().toISOString();
    let meta: McpMeta;
    try {
      const toolCount = await this.check(previous.url, previous.hasToken ? this.secrets.getSecret(mcpTokenSecret(name)) : undefined);
      meta = { url: previous.url, hasToken: previous.hasToken, connectedAt: previous.connectedAt, verifiedAt: now, toolCount };
    } catch (error) {
      if (!(error instanceof McpConnectorError)) throw error;
      meta = { ...previous, verifiedAt: now, error: error.message };
    }
    this.save({ ...this.all(), [name]: meta });
    return this.statusOf(name, meta);
  }

  remove(name: string): boolean {
    const all = this.all();
    if (all[name] === undefined) return false;
    delete all[name];
    this.save(all);
    this.secrets.removeSecret(mcpTokenSecret(name));
    return true;
  }
}

export function registerMcpConnectorRoutes(app: Express, service: McpConnectorService): void {
  app.get('/settings/mcp-connectors', (_req, res) => {
    res.json(service.list());
  });

  app.put(
    '/settings/mcp-connectors/:name',
    asyncRoute(async (req, res) => {
      try {
        res.json(await service.connect(paramId(req, 'name'), (req.body ?? {}) as McpConnectRequest));
      } catch (error) {
        if (!(error instanceof McpConnectorError)) throw error;
        sendError(res, 422, error.message, 'LOUSHO_CONNECTOR_INVALID');
      }
    }),
  );

  app.post(
    '/settings/mcp-connectors/:name/verify',
    asyncRoute(async (req, res) => {
      try {
        res.json(await service.verifyNow(paramId(req, 'name')));
      } catch (error) {
        if (!(error instanceof McpConnectorError)) throw error;
        sendError(res, error.message === NOT_FOUND ? 404 : 422, error.message, 'LOUSHO_CONNECTOR_INVALID');
      }
    }),
  );

  app.delete('/settings/mcp-connectors/:name', (req, res) => {
    if (!service.remove(paramId(req, 'name'))) {
      sendError(res, 404, NOT_FOUND);
      return;
    }
    res.json({ ok: true });
  });
}
