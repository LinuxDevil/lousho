import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Express, Request } from 'express';
import type { CreateInboundRequest, CreatedInbound, InboundDelivery, InboundEndpoint } from '../../shared/profileWire';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
import { renderTemplate } from '../triggers/template';
import type { WorkspaceResolver } from '../workspace/context';
import { bearerOf, parseTargets, readJson, startTargetRun, writeJson } from './profileFiles';

const DEFAULT_TEMPLATE = 'An event arrived:\n\n{{event}}';
const MAX_SKEW_S = 300;
const LOG_MAX_BYTES = 2_000_000;
const LOG_KEEP_LINES = 1000;
const HIDDEN_HEADERS = /^(authorization|cookie|x-lousho-token|x-lousho-signature|x-hub-signature.*|x-slack-signature)$/;

const secretName = (id: string) => `LOUSHO_INBOUND_${id.toUpperCase()}`;
const sameText = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const hmacHex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function freshTimestamp(ts: string | undefined): boolean {
  const n = Number(ts);
  return Number.isFinite(n) && Math.abs(Date.now() / 1000 - n) <= MAX_SKEW_S;
}

export function verifyInbound(req: Request, mode: InboundEndpoint['mode'], secret: string, raw: Buffer): string | undefined {
  if (mode === 'token') {
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const given = bearerOf(req.headers.authorization) ?? header(req, 'x-lousho-token') ?? queryToken;
    return given !== undefined && sameText(given, secret) ? undefined : 'Missing or wrong token';
  }
  const lousho = header(req, 'x-lousho-signature');
  if (lousho !== undefined) {
    const ts = header(req, 'x-lousho-timestamp');
    if (!freshTimestamp(ts)) return 'Timestamp missing or more than 5 minutes off';
    const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${ts}.`), raw]));
    return sameText(lousho.replace(/^sha256=/, ''), expected) ? undefined : 'Signature does not match';
  }
  const github = header(req, 'x-hub-signature-256');
  if (github !== undefined) {
    return sameText(github, `sha256=${hmacHex(secret, raw)}`) ? undefined : 'Signature does not match';
  }
  const slack = header(req, 'x-slack-signature');
  if (slack !== undefined) {
    const ts = header(req, 'x-slack-request-timestamp');
    if (!freshTimestamp(ts)) return 'Timestamp missing or more than 5 minutes off';
    return sameText(slack, `v0=${hmacHex(secret, Buffer.concat([Buffer.from(`v0:${ts}:`), raw]))}`) ? undefined : 'Signature does not match';
  }
  return 'No signature header';
}

function eventOf(raw: Buffer): unknown {
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class InboundService {
  constructor(
    private readonly file: string,
    private readonly logFile: string,
    private readonly secrets: SecretsStore,
  ) {}

  list(): InboundEndpoint[] {
    return readJson<InboundEndpoint[]>(this.file, []);
  }

  get(id: string): InboundEndpoint | undefined {
    return this.list().find((e) => e.id === id);
  }

  create(request: CreateInboundRequest): CreatedInbound {
    const id = randomBytes(6).toString('hex');
    const endpoint: InboundEndpoint = {
      id,
      name: request.name,
      mode: request.mode,
      targets: request.targets,
      promptTemplate: request.promptTemplate?.trim() || DEFAULT_TEMPLATE,
      createdAt: new Date().toISOString(),
      ...(request.expiresAt !== undefined && { expiresAt: request.expiresAt }),
      path: `/hooks/_in/${id}`,
    };
    const secret = randomBytes(24).toString('base64url');
    this.secrets.setSecret(secretName(id), secret);
    writeJson(this.file, [...this.list(), endpoint]);
    return { endpoint, secret };
  }

  rotate(id: string): CreatedInbound | undefined {
    const endpoint = this.get(id);
    if (endpoint === undefined) return undefined;
    const secret = randomBytes(24).toString('base64url');
    this.secrets.setSecret(secretName(id), secret);
    return { endpoint, secret };
  }

  remove(id: string): boolean {
    const all = this.list();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    this.secrets.removeSecret(secretName(id));
    writeJson(this.file, next);
    return true;
  }

  secretOf(id: string): string | undefined {
    return this.secrets.getSecret(secretName(id));
  }

  record(delivery: InboundDelivery): void {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.logFile, `${JSON.stringify(delivery)}\n`, { mode: 0o600 });
    if (fs.statSync(this.logFile).size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-LOG_KEEP_LINES);
      fs.writeFileSync(this.logFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    }
  }

  deliveries(id: string, limit = 50): InboundDelivery[] {
    let text = '';
    try {
      text = fs.readFileSync(this.logFile, 'utf8');
    } catch {
      return [];
    }
    const rows: InboundDelivery[] = [];
    for (const line of text.trim().split('\n').reverse()) {
      if (rows.length >= limit) break;
      try {
        const row = JSON.parse(line) as InboundDelivery;
        if (row.endpointId === id) rows.push(row);
      } catch {}
    }
    return rows;
  }
}

function parseCreate(body: unknown): CreateInboundRequest | string {
  const { name, mode, targets, promptTemplate, expiresAt } = (body ?? {}) as Partial<CreateInboundRequest>;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) return 'Give the endpoint a name of 1 to 80 characters.';
  if (mode !== 'hmac' && mode !== 'token') return "mode must be 'hmac' or 'token'.";
  const parsed = parseTargets(targets);
  if (parsed === undefined) return 'Pick 1 to 50 agents the endpoint may start.';
  if (promptTemplate !== undefined && (typeof promptTemplate !== 'string' || promptTemplate.length > 10_000)) return 'promptTemplate must be text of at most 10000 characters.';
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) return 'expiresAt must be a date.';
  return {
    name: name.trim(),
    mode,
    targets: parsed,
    ...(promptTemplate !== undefined && { promptTemplate }),
    ...(expiresAt !== undefined && { expiresAt: new Date(expiresAt).toISOString() }),
  };
}

export function registerInboundRoutes(app: Express, service: InboundService, resolver: WorkspaceResolver): void {
  app.get('/settings/inbound', (_req, res) => {
    res.json(service.list());
  });

  app.post('/settings/inbound', (req, res) => {
    const parsed = parseCreate(req.body);
    if (typeof parsed === 'string') {
      sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
      return;
    }
    res.status(201).json(service.create(parsed));
  });

  app.post('/settings/inbound/:id/rotate', (req, res) => {
    const rotated = service.rotate(paramId(req));
    if (rotated === undefined) {
      sendError(res, 404, 'No such endpoint');
      return;
    }
    res.json(rotated);
  });

  app.delete('/settings/inbound/:id', (req, res) => {
    if (!service.remove(paramId(req))) {
      sendError(res, 404, 'No such endpoint');
      return;
    }
    res.status(204).end();
  });

  app.get('/settings/inbound/:id/deliveries', (req, res) => {
    res.json(service.deliveries(paramId(req)));
  });

  app.post(
    '/hooks/_in/:id',
    asyncRoute(async (req, res) => {
      const id = paramId(req);
      const endpoint = service.get(id);
      const secret = service.secretOf(id);
      if (endpoint === undefined || secret === undefined) {
        sendError(res, 404, 'No endpoint here');
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const base = { id: randomBytes(8).toString('hex'), endpointId: id, at: new Date().toISOString(), bytes: raw.length };
      const expired = endpoint.expiresAt !== undefined && Date.parse(endpoint.expiresAt) < Date.now();
      const problem = expired ? 'Endpoint expired' : verifyInbound(req, endpoint.mode, secret, raw);
      if (problem !== undefined) {
        service.record({ ...base, accepted: false, reason: problem, runs: [] });
        sendError(res, expired ? 410 : 401, problem, 'LOUSHO_INBOUND_REJECTED');
        return;
      }
      const event = eventOf(raw);
      if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'url_verification') {
        service.record({ ...base, accepted: true, reason: 'Slack URL verification', runs: [] });
        res.json({ challenge: (event as { challenge?: unknown }).challenge });
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name, value]) => typeof value === 'string' && !HIDDEN_HEADERS.test(name)),
      );
      const input = renderTemplate(endpoint.promptTemplate, { event, headers }).trim() || 'An event arrived.';
      const runs = [];
      for (const target of endpoint.targets) {
        runs.push({ ...target, ...(await startTargetRun(resolver, target, input, `inbound:${endpoint.name}`)) });
      }
      service.record({ ...base, accepted: true, runs });
      res.status(202).json({ accepted: true, runs });
    }),
  );
}
