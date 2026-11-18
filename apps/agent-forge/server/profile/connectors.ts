import { randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import {
  CONNECTORS,
  GOOGLE_REFRESH_SECRET,
  type ConnectRequest,
  type ConnectResponse,
  type ConnectorDef,
  type ConnectorId,
  type ConnectorStatus,
} from '../../shared/profileWire';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
import { readJson, writeJson } from './profileFiles';

interface ConnectorMeta {
  account?: string;
  connectedAt: string;
  scopes?: string[];
}

type MetaFile = Partial<Record<ConnectorId, ConnectorMeta>>;

interface Verified {
  account?: string;
  scopes?: string[];
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];

const GOOGLE_CALLBACK = '/settings/connectors/google/callback';
const STATE_TTL_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 10_000;

class VerifyError extends Error {}

function defOf(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

function cleanUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VerifyError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new VerifyError(`${label} must start with https://`);
  return url.toString().replace(/\/+$/, '');
}

async function call(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  } catch (error) {
    throw new VerifyError(`Could not reach ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return res;
}

async function expectOk(res: Response, what: string): Promise<unknown> {
  const body = await res.json().catch(() => undefined);
  if (res.ok) return body;
  if (res.status === 401 || res.status === 403) throw new VerifyError(`${what} rejected these credentials (${res.status}).`);
  throw new VerifyError(`${what} answered ${res.status}.`);
}

const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

const scopesHeader = (res: Response) =>
  (res.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function verify(id: ConnectorId, v: Record<string, string>): Promise<Verified> {
  switch (id) {
    case 'github': {
      const res = await call('https://api.github.com/user', { headers: { Authorization: `Bearer ${v.token}`, 'User-Agent': 'lousho-studio' } }, 'GitHub');
      const body = (await expectOk(res, 'GitHub')) as { login?: string };
      const scopes = scopesHeader(res);
      return { account: body.login, ...(scopes.length > 0 && { scopes }) };
    }
    case 'atlassian': {
      const res = await call(`${v.baseUrl}/rest/api/3/myself`, { headers: { Authorization: basic(v.email, v.apiToken), Accept: 'application/json' } }, 'Atlassian');
      const body = (await expectOk(res, 'Atlassian')) as { displayName?: string; emailAddress?: string };
      return { account: `${body.displayName ?? v.email} · ${new URL(v.baseUrl).host}` };
    }
    case 'slack': {
      if (!v.botToken && !v.webhookUrl) throw new VerifyError('Add a bot token, a webhook URL, or both.');
      if (v.webhookUrl && !/^https:\/\/hooks\.slack\.com\//.test(v.webhookUrl)) throw new VerifyError('The webhook URL must start with https://hooks.slack.com/');
      if (!v.botToken) return { account: 'Incoming webhook' };
      const res = await call('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${v.botToken}` } }, 'Slack');
      const body = (await expectOk(res, 'Slack')) as { ok?: boolean; error?: string; user?: string; team?: string };
      if (!body.ok) throw new VerifyError(`Slack rejected the bot token (${body.error ?? 'unknown error'}).`);
      const scopes = scopesHeader(res);
      return { account: `${body.user ?? 'bot'} · ${body.team ?? 'Slack'}`, ...(scopes.length > 0 && { scopes }) };
    }
    case 'jenkins': {
      const res = await call(`${v.baseUrl}/me/api/json`, { headers: { Authorization: basic(v.username, v.apiToken) } }, 'Jenkins');
      const body = (await expectOk(res, 'Jenkins')) as { fullName?: string; id?: string };
      return { account: `${body.fullName ?? body.id ?? v.username} · ${new URL(v.baseUrl).host}` };
    }
    case 'figma': {
      const res = await call('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': v.token } }, 'Figma');
      const body = (await expectOk(res, 'Figma')) as { handle?: string; email?: string };
      return { account: body.email ?? body.handle };
    }
    case 'email': {
      const res = await call('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${v.apiKey}` } }, 'Resend');
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { name?: string };
        if (body.name === 'restricted_api_key') return { account: v.defaultFrom || 'Sending-only key' };
      }
      const body = (await expectOk(res, 'Resend')) as { data?: Array<{ name: string }> };
      return { account: v.defaultFrom || body.data?.map((d) => d.name).join(', ') || 'Resend' };
    }
    case 'google':
      return {};
  }
}

function originOf(req: Request): string {
  const asked = typeof req.query.origin === 'string' ? req.query.origin : undefined;
  if (asked !== undefined) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === asked) return url.origin;
    } catch {}
  }
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

export class ConnectorService {
  private readonly states = new Map<string, { redirectUri: string; at: number }>();

  constructor(
    private readonly file: string,
    private readonly secrets: SecretsStore,
  ) {}

  private meta(): MetaFile {
    return readJson<MetaFile>(this.file, {});
  }

  private has(name: string): boolean {
    return this.secrets.getSecret(name) !== undefined;
  }

  status(def: ConnectorDef): ConnectorStatus {
    const filled = def.fields.filter((f) => this.has(f.secret)).map((f) => f.key);
    const requiredOk = def.fields.filter((f) => f.required).every((f) => filled.includes(f.key));
    const connected = requiredOk && filled.length > 0 && (def.id !== 'google' || this.has(GOOGLE_REFRESH_SECRET));
    const meta = this.meta()[def.id];
    return {
      id: def.id,
      connected,
      filled,
      ...(connected && meta?.account !== undefined && { account: meta.account }),
      ...(connected && meta?.connectedAt !== undefined && { connectedAt: meta.connectedAt }),
      ...(connected && meta?.scopes !== undefined && { scopes: meta.scopes }),
    };
  }

  list(): ConnectorStatus[] {
    return CONNECTORS.map((def) => this.status(def));
  }

  private saveMeta(id: ConnectorId, meta: ConnectorMeta | undefined): void {
    const all = this.meta();
    if (meta === undefined) delete all[id];
    else all[id] = meta;
    writeJson(this.file, all);
  }

  async connect(def: ConnectorDef, request: ConnectRequest): Promise<ConnectResponse> {
    const values: Record<string, string> = {};
    for (const field of def.fields) {
      const raw = request.values?.[field.key];
      const typed = typeof raw === 'string' ? raw.trim() : '';
      const value = typed !== '' ? typed : (this.secrets.getSecret(field.secret) ?? '');
      if (field.required && value === '') throw new VerifyError(`${field.label} is required.`);
      if (value !== '') values[field.key] = /url$/i.test(field.key) ? cleanUrl(value, field.label) : value;
    }
    const verified = await verify(def.id, values);
    for (const field of def.fields) {
      const value = values[field.key];
      if (value !== undefined) this.secrets.setSecret(field.secret, value);
    }
    if (def.id === 'google') {
      return { status: this.status(def), authUrl: '/settings/connectors/google/start' };
    }
    this.saveMeta(def.id, { ...verified, connectedAt: new Date().toISOString() });
    return { status: this.status(def) };
  }

  disconnect(def: ConnectorDef): ConnectorStatus {
    for (const field of def.fields) this.secrets.removeSecret(field.secret);
    if (def.id === 'google') this.secrets.removeSecret(GOOGLE_REFRESH_SECRET);
    this.saveMeta(def.id, undefined);
    return this.status(def);
  }

  googleAuthUrl(origin: string): string {
    const clientId = this.secrets.getSecret('GOOGLE_CLIENT_ID');
    if (clientId === undefined) throw new VerifyError('Save the Google OAuth client ID and secret first.');
    const now = Date.now();
    for (const [key, value] of this.states) if (now - value.at > STATE_TTL_MS) this.states.delete(key);
    const state = randomBytes(16).toString('hex');
    const redirectUri = `${origin}${GOOGLE_CALLBACK}`;
    this.states.set(state, { redirectUri, at: now });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async googleCallback(state: string, code: string): Promise<void> {
    const pending = this.states.get(state);
    this.states.delete(state);
    if (pending === undefined || Date.now() - pending.at > STATE_TTL_MS) throw new VerifyError('The Google sign-in expired. Try again.');
    const clientId = this.secrets.getSecret('GOOGLE_CLIENT_ID');
    const clientSecret = this.secrets.getSecret('GOOGLE_CLIENT_SECRET');
    if (clientId === undefined || clientSecret === undefined) throw new VerifyError('The Google OAuth client is not saved.');
    const res = await call(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' }),
      },
      'Google',
    );
    const token = (await expectOk(res, 'Google')) as { refresh_token?: string; access_token?: string; scope?: string };
    if (!token.refresh_token) throw new VerifyError('Google returned no refresh token. Remove Lousho from your Google account permissions and try again.');
    const info = await call('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } }, 'Google');
    const user = (await info.json().catch(() => ({}))) as { email?: string };
    this.secrets.setSecret(GOOGLE_REFRESH_SECRET, token.refresh_token);
    this.saveMeta('google', {
      ...(user.email !== undefined && { account: user.email }),
      connectedAt: new Date().toISOString(),
      scopes: (token.scope ?? '').split(' ').filter(Boolean).map((s) => s.replace('https://www.googleapis.com/auth/', '')),
    });
  }
}

export function registerConnectorRoutes(app: Express, service: ConnectorService): void {
  app.get('/settings/connectors', (_req, res) => {
    res.json(service.list());
  });

  app.put(
    '/settings/connectors/:provider',
    asyncRoute(async (req, res) => {
      const def = defOf(paramId(req, 'provider'));
      if (def === undefined) {
        sendError(res, 404, 'Unknown connector');
        return;
      }
      try {
        res.json(await service.connect(def, (req.body ?? {}) as ConnectRequest));
      } catch (error) {
        if (!(error instanceof VerifyError)) throw error;
        sendError(res, 422, error.message, 'LOUSHO_CONNECTOR_INVALID');
      }
    }),
  );

  app.delete('/settings/connectors/:provider', (req, res) => {
    const def = defOf(paramId(req, 'provider'));
    if (def === undefined) {
      sendError(res, 404, 'Unknown connector');
      return;
    }
    res.json(service.disconnect(def));
  });

  app.get('/settings/connectors/google/start', (req, res) => {
    try {
      res.redirect(302, service.googleAuthUrl(originOf(req)));
    } catch (error) {
      res.redirect(302, `/#/profile/connectors?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
  });

  app.get(
    GOOGLE_CALLBACK,
    asyncRoute(async (req, res) => {
      const { state, code, error } = req.query as Record<string, string | undefined>;
      let problem = error !== undefined ? `Google sign-in failed: ${error}` : undefined;
      if (problem === undefined) {
        try {
          await service.googleCallback(String(state ?? ''), String(code ?? ''));
        } catch (cause) {
          if (!(cause instanceof VerifyError)) throw cause;
          problem = cause.message;
        }
      }
      res.redirect(302, problem === undefined ? '/#/profile/connectors?connected=google' : `/#/profile/connectors?error=${encodeURIComponent(problem)}`);
    }),
  );
}
