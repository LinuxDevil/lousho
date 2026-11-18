import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { AutomationKey, CreateAutomationKeyRequest, CreatedAutomationKey } from '../../shared/profileWire';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { WorkspaceResolver } from '../workspace/context';
import { bearerOf, parseTargets, rateLimit, readJson, startTargetRun, writeJson } from './profileFiles';

interface StoredKey extends AutomationKey {
  hash: string;
}

const MAX_INPUT = 100_000;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

function newToken(): { token: string; prefix: string; hash: string } {
  const token = `lsk_${randomBytes(24).toString('base64url')}`;
  return { token, prefix: token.slice(0, 12), hash: hashOf(token) };
}

const publicKey = ({ id, name, prefix, targets, createdAt, lastUsedAt }: StoredKey): AutomationKey => ({
  id,
  name,
  prefix,
  targets,
  createdAt,
  ...(lastUsedAt !== undefined && { lastUsedAt }),
});

export class AutomationKeyStore {
  constructor(private readonly file: string) {}

  private all(): StoredKey[] {
    return readJson<StoredKey[]>(this.file, []);
  }

  list(): AutomationKey[] {
    return this.all().map(publicKey);
  }

  create(request: CreateAutomationKeyRequest): CreatedAutomationKey {
    const { token, prefix, hash } = newToken();
    const key: StoredKey = { id: randomUUID(), name: request.name, prefix, targets: request.targets, createdAt: new Date().toISOString(), hash };
    writeJson(this.file, [...this.all(), key]);
    return { key: publicKey(key), token };
  }

  rotate(id: string): CreatedAutomationKey | undefined {
    const keys = this.all();
    const key = keys.find((k) => k.id === id);
    if (key === undefined) return undefined;
    const { token, prefix, hash } = newToken();
    Object.assign(key, { prefix, hash });
    delete key.lastUsedAt;
    writeJson(this.file, keys);
    return { key: publicKey(key), token };
  }

  remove(id: string): boolean {
    const keys = this.all();
    const next = keys.filter((k) => k.id !== id);
    writeJson(this.file, next);
    return next.length !== keys.length;
  }

  match(token: string): AutomationKey | undefined {
    const hash = hashOf(token);
    const keys = this.all();
    const key = keys.find((k) => k.hash === hash);
    if (key === undefined) return undefined;
    key.lastUsedAt = new Date().toISOString();
    writeJson(this.file, keys);
    return publicKey(key);
  }
}

function parseCreate(body: unknown): CreateAutomationKeyRequest | string {
  const { name, targets } = (body ?? {}) as Partial<CreateAutomationKeyRequest>;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) return 'Give the key a name of 1 to 80 characters.';
  const parsed = parseTargets(targets);
  if (parsed === undefined) return 'Pick 1 to 50 agents the key may start.';
  return { name: name.trim(), targets: parsed };
}

export function registerAutomationKeyRoutes(app: Express, store: AutomationKeyStore, resolver: WorkspaceResolver): void {
  app.get('/settings/automation-keys', (_req, res) => {
    res.json(store.list());
  });

  app.post('/settings/automation-keys', (req, res) => {
    const parsed = parseCreate(req.body);
    if (typeof parsed === 'string') {
      sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
      return;
    }
    res.status(201).json(store.create(parsed));
  });

  app.post('/settings/automation-keys/:id/rotate', (req, res) => {
    const rotated = store.rotate(paramId(req));
    if (rotated === undefined) {
      sendError(res, 404, 'No such key');
      return;
    }
    res.json(rotated);
  });

  app.delete('/settings/automation-keys/:id', (req, res) => {
    if (!store.remove(paramId(req))) {
      sendError(res, 404, 'No such key');
      return;
    }
    res.status(204).end();
  });

  app.post(
    '/hooks/_trigger',
    rateLimit(60),
    asyncRoute(async (req, res) => {
      const header = req.headers['x-api-key'];
      const token = bearerOf(req.headers.authorization) ?? (Array.isArray(header) ? header[0] : header);
      const key = token === undefined ? undefined : store.match(token);
      if (key === undefined) {
        sendError(res, 401, 'Missing or unknown automation key', 'LOUSHO_KEY_INVALID');
        return;
      }
      let body: { agentId?: unknown; workspaceId?: unknown; input?: unknown };
      try {
        body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}') as typeof body;
      } catch {
        sendError(res, 400, 'Body must be JSON', 'LOUSHO_BODY_INVALID');
        return;
      }
      const input = typeof body.input === 'string' && body.input.trim() !== '' ? body.input : 'Run the agent.';
      if (input.length > MAX_INPUT) {
        sendError(res, 413, 'input is too long', 'LOUSHO_BODY_INVALID');
        return;
      }
      const target = key.targets.find(
        (t) => t.agentId === body.agentId && (body.workspaceId === undefined || t.workspaceId === body.workspaceId),
      );
      if (target === undefined) {
        sendError(res, 403, 'This key may not start that agent', 'LOUSHO_KEY_SCOPE');
        return;
      }
      const result = await startTargetRun(resolver, target, input, `api:${key.name}`);
      const status = { started: 202, busy: 409, disabled: 409, missing: 404, error: 422 }[result.outcome];
      res.status(status).json({ ...target, ...result });
    }),
  );
}
