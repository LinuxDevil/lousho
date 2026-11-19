import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from '../secretsStore';
import { AlreadyRunningError } from '../runRegistry';
import type { WorkspaceContext, WorkspaceResolver } from '../workspace/context';
import { AutomationKeyStore, registerAutomationKeyRoutes } from './automationKeys';
import { ConnectorService, registerConnectorRoutes } from './connectors';
import { InboundService, registerInboundRoutes } from './inbound';
import { rateLimit } from './profileFiles';
import { eventFor, parseNotificationSettings } from './notifications';
import { CONNECTORS } from '../../shared/profileWire';

const WS = 'demo-abc123';
const target = { workspaceId: WS, agentId: 'bot' };

let dir: string;
let secrets: SecretsStore;
let run: ReturnType<typeof vi.fn>;
let app: Express;

function resolver(): WorkspaceResolver {
  const ctx = {
    repo: { readSpec: async (id: string) => (id === 'bot' ? { name: 'Bot' } : undefined) },
    triggers: { isEnabled: () => true },
    runs: { run },
  } as unknown as WorkspaceContext;
  return { resolve: async (id) => (id === WS ? ctx : undefined), defaultId: () => WS, retain: () => () => {} };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-profile-'));
  secrets = new SecretsStore(dir);
  run = vi.fn().mockResolvedValue(undefined);
  app = express();
  app.use('/hooks', express.raw({ type: () => true }));
  app.use(express.json());
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('automation keys', () => {
  beforeEach(() => registerAutomationKeyRoutes(app, new AutomationKeyStore(path.join(dir, 'keys.json')), resolver()));

  it('starts an allowed agent with a valid key and keeps only a hash', async () => {
    const created = await request(app).post('/settings/automation-keys').send({ name: 'CI', targets: [target] });
    expect(created.status).toBe(201);
    const token: string = created.body.token;
    expect(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).not.toContain(token);

    const res = await request(app).post('/hooks/_trigger').set('Authorization', `Bearer ${token}`).send(JSON.stringify({ agentId: 'bot', input: 'hi' }));
    expect(res.status).toBe(202);
    expect(run).toHaveBeenCalledWith('bot', 'hi', undefined, { source: 'trigger', triggerId: 'api:CI' });
    expect((await request(app).get('/settings/automation-keys')).body[0].lastUsedAt).toBeDefined();
  });

  it('refuses unknown keys, out-of-scope agents, rotated keys and busy agents', async () => {
    const { body } = await request(app).post('/settings/automation-keys').send({ name: 'CI', targets: [target] });
    expect((await request(app).post('/hooks/_trigger').set('x-api-key', 'lsk_nope').send('{}')).status).toBe(401);
    expect((await request(app).post('/hooks/_trigger').set('x-api-key', body.token).send(JSON.stringify({ agentId: 'other' }))).status).toBe(403);

    run.mockRejectedValueOnce(new AlreadyRunningError('busy'));
    expect((await request(app).post('/hooks/_trigger').set('x-api-key', body.token).send(JSON.stringify({ agentId: 'bot' }))).status).toBe(409);

    const rotated = await request(app).post(`/settings/automation-keys/${body.key.id}/rotate`);
    expect((await request(app).post('/hooks/_trigger').set('x-api-key', body.token).send(JSON.stringify({ agentId: 'bot' }))).status).toBe(401);
    expect((await request(app).post('/hooks/_trigger').set('x-api-key', rotated.body.token).send(JSON.stringify({ agentId: 'bot' }))).status).toBe(202);
  });

  it('validates new keys', async () => {
    expect((await request(app).post('/settings/automation-keys').send({ name: '', targets: [target] })).status).toBe(400);
    expect((await request(app).post('/settings/automation-keys').send({ name: 'x', targets: [{ workspaceId: '../x', agentId: 'bot' }] })).status).toBe(400);
  });
});

describe('inbound endpoints', () => {
  let service: InboundService;
  beforeEach(() => {
    service = new InboundService(path.join(dir, 'inbound.json'), path.join(dir, 'log.jsonl'), secrets);
    registerInboundRoutes(app, service, resolver());
  });

  const create = async (mode: 'hmac' | 'token') =>
    (await request(app).post('/settings/inbound').send({ name: 'In', mode, targets: [target], promptTemplate: 'Action: {{event.action}}' })).body as {
      endpoint: { id: string; path: string };
      secret: string;
    };

  it('accepts a correctly signed Lousho event and renders the prompt', async () => {
    const { endpoint, secret } = await create('hmac');
    const body = JSON.stringify({ action: 'opened' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const res = await request(app).post(endpoint.path).set('x-lousho-timestamp', ts).set('x-lousho-signature', `sha256=${sig}`).send(body);
    expect(res.status).toBe(202);
    expect(run).toHaveBeenCalledWith('bot', 'Action: opened', undefined, { source: 'trigger', triggerId: 'inbound:In' });
    expect(service.deliveries(endpoint.id)[0]).toMatchObject({ accepted: true, runs: [{ outcome: 'started' }] });
  });

  it('accepts GitHub and Slack signatures and rejects tampering and stale timestamps', async () => {
    const { endpoint, secret } = await create('hmac');
    const body = '{"action":"x"}';
    const gh = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect((await request(app).post(endpoint.path).set('x-hub-signature-256', gh).send(body)).status).toBe(202);
    expect((await request(app).post(endpoint.path).set('x-hub-signature-256', gh).send('{"action":"y"}')).status).toBe(401);

    const ts = String(Math.floor(Date.now() / 1000));
    const slack = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
    expect((await request(app).post(endpoint.path).set('x-slack-request-timestamp', ts).set('x-slack-signature', slack).send(body)).status).toBe(202);

    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const stale = createHmac('sha256', secret).update(`${old}.${body}`).digest('hex');
    expect((await request(app).post(endpoint.path).set('x-lousho-timestamp', old).set('x-lousho-signature', stale).send(body)).status).toBe(401);
    expect((await request(app).post(endpoint.path).send(body)).status).toBe(401);
    expect(service.deliveries(endpoint.id).filter((d) => !d.accepted)).toHaveLength(3);
  });

  it('checks tokens, answers Slack URL verification, and forgets deleted endpoints', async () => {
    const { endpoint, secret } = await create('token');
    expect((await request(app).post(endpoint.path).set('Authorization', 'Bearer wrong').send('{}')).status).toBe(401);
    expect((await request(app).post(`${endpoint.path}?token=${secret}`).send('{}')).status).toBe(202);
    const challenge = await request(app).post(endpoint.path).set('x-lousho-token', secret).send(JSON.stringify({ type: 'url_verification', challenge: 'c1' }));
    expect(challenge.body).toEqual({ challenge: 'c1' });

    expect((await request(app).delete(`/settings/inbound/${endpoint.id}`)).status).toBe(204);
    expect(secrets.getSecret(`LOUSHO_INBOUND_${endpoint.id.toUpperCase()}`)).toBeUndefined();
    expect((await request(app).post(`${endpoint.path}?token=${secret}`).send('{}')).status).toBe(404);
  });
});

describe('notifications', () => {
  it('fires on run transitions only', () => {
    expect(eventFor(undefined, 'running')).toBe('started');
    expect(eventFor('paused', 'running')).toBeUndefined();
    expect(eventFor('running', 'paused')).toBeUndefined();
    expect(eventFor('running', 'done')).toBe('completed');
    expect(eventFor('running', 'error')).toBe('failed');
    expect(eventFor('done', 'done')).toBeUndefined();
  });

  it('validates settings', () => {
    expect(parseNotificationSettings({ channel: 'pager', events: {} })).toEqual(expect.any(String));
    expect(
      parseNotificationSettings({ channel: 'slack', events: { started: false, completed: true, failed: true }, slackChannel: ' #ops ', overrides: { [`${WS}/bot`]: 'off' } }),
    ).toEqual({ channel: 'slack', events: { started: false, completed: true, failed: true }, slackChannel: '#ops', overrides: { [`${WS}/bot`]: 'off' } });
    expect(parseNotificationSettings({ channel: 'off', events: { started: true, completed: true, failed: true }, overrides: { '../x': 'off' } })).toEqual(expect.any(String));
  });
});

describe('connectors', () => {
  const def = (id: string) => CONNECTORS.find((c) => c.id === id)!;
  const github = def('github');
  const atlassian = def('atlassian');
  const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
  const stub = (res: Response) => {
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const service = () => new ConnectorService(path.join(dir, 'connectors.json'), secrets);
  const basicOf = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('checks GitHub and stores the login and scopes', async () => {
    const fetchMock = stub(json({ login: 'octo' }, { headers: { 'x-oauth-scopes': 'repo, read:org' } }));
    const { status } = await service().connect(github, { values: { token: 'ghp_x' } });
    expect(status).toMatchObject({ connected: true, account: 'octo', scopes: ['repo', 'read:org'] });
    expect(status.verifiedAt).toBeDefined();
    expect(status.error).toBeUndefined();
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_x');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(init.headers).toEqual({ Authorization: 'Bearer ghp_x', Accept: 'application/vnd.github+json', 'User-Agent': 'lousho' });
  });

  it('checks Atlassian with basic auth and falls back to the email', async () => {
    const fetchMock = stub(json({ displayName: 'Ann' }));
    const svc = service();
    const values = { baseUrl: 'https://x.atlassian.net/', email: 'a@b.c', apiToken: 'tok' };
    expect((await svc.connect(atlassian, { values })).status.account).toBe('Ann');
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.atlassian.net/rest/api/3/myself');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(basicOf('a@b.c', 'tok'));
    stub(json({ emailAddress: 'a@b.c' }));
    expect((await svc.verifyNow(atlassian)).account).toBe('a@b.c');
  });

  it('checks Slack auth.test and reads ok:false as an error', async () => {
    const slack = def('slack');
    const fetchMock = stub(json({ ok: true, user: 'bot', team: 'Acme' }));
    const svc = service();
    expect((await svc.connect(slack, { values: { botToken: 'xoxb-1' } })).status.account).toBe('bot · Acme');
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/auth.test');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer xoxb-1' } });
    stub(json({ ok: false, error: 'invalid_auth' }));
    expect(await svc.verifyNow(slack)).toMatchObject({ connected: true, error: 'Slack: invalid_auth' });
  });

  it('skips the Slack check for a webhook-only connection', async () => {
    const fetchMock = stub(json({}));
    const { status } = await service().connect(def('slack'), { values: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status).toMatchObject({ connected: true });
    expect(status.verifiedAt).toBeUndefined();
  });

  it('checks Figma with the token header', async () => {
    const fetchMock = stub(json({ handle: 'fig', email: 'f@x.y' }));
    const { status } = await service().connect(def('figma'), { values: { token: 'figd_1' } });
    expect(status.account).toBe('fig');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.figma.com/v1/me');
    expect(fetchMock.mock.calls[0][1].headers['X-Figma-Token']).toBe('figd_1');
  });

  it('checks Jenkins whoAmI with basic auth', async () => {
    const fetchMock = stub(json({ name: 'builder' }));
    const { status } = await service().connect(def('jenkins'), { values: { baseUrl: 'https://ci.example.com/', username: 'bob', apiToken: 'jt' } });
    expect(status.account).toBe('builder');
    expect(fetchMock.mock.calls[0][0]).toBe('https://ci.example.com/whoAmI/api/json');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(basicOf('bob', 'jt'));
  });

  it('does not check Email', async () => {
    const fetchMock = stub(json({}));
    const { status } = await service().connect(def('email'), { values: { apiKey: 're_1' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status).toMatchObject({ connected: true });
    expect(status.verifiedAt).toBeUndefined();
  });

  it('still saves when the check fails and reports the provider message', async () => {
    stub(json({ message: 'Bad credentials' }, { status: 401 }));
    const svc = service();
    const { status } = await svc.connect(github, { values: { token: 'ghp_bad' } });
    expect(status).toMatchObject({ connected: true, error: 'GitHub answered 401: Bad credentials' });
    expect(status.account).toBeUndefined();
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_bad');
    expect(svc.list().find((c) => c.id === 'github')?.error).toBe('GitHub answered 401: Bad credentials');
  });

  it('reports an unreachable service as an error, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    const { status } = await service().connect(github, { values: { token: 'ghp_x' } });
    expect(status).toMatchObject({ connected: true, error: 'Could not reach GitHub' });
  });

  it('clips long provider messages', async () => {
    stub(new Response('x'.repeat(500), { status: 500 }));
    const { status } = await service().connect(github, { values: { token: 'ghp_x' } });
    expect(status.error!.length).toBeLessThanOrEqual(200);
  });

  it('keeps saved values on reconnect, re-verifies on demand, and clears the identity on disconnect', async () => {
    const svc = service();
    secrets.setSecret('JIRA_API_TOKEN', 'kept');
    const fetchMock = stub(json({ displayName: 'Ann' }));
    await svc.connect(atlassian, { values: { baseUrl: 'https://x.atlassian.net/', email: 'a@b.c', apiToken: '' } });
    expect(secrets.getSecret('JIRA_API_TOKEN')).toBe('kept');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(basicOf('a@b.c', 'kept'));

    stub(json({ message: 'expired' }, { status: 401 }));
    expect((await svc.verifyNow(atlassian)).error).toBe('Atlassian answered 401: expired');

    expect(svc.disconnect(atlassian).connected).toBe(false);
    expect(secrets.getSecret('JIRA_BASE_URL')).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'connectors.json'), 'utf8')).not.toContain('atlassian');
    await expect(svc.verifyNow(atlassian)).rejects.toThrow(/not connected/);
  });

  it('serves the verify route', async () => {
    registerConnectorRoutes(app, service());
    stub(json({ login: 'octo' }));
    await request(app).put('/settings/connectors/github').send({ values: { token: 'ghp_x' } });
    stub(json({ login: 'octo2' }));
    const res = await request(app).post('/settings/connectors/github/verify');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, account: 'octo2' });
    expect((await request(app).post('/settings/connectors/figma/verify')).status).toBe(422);
    expect((await request(app).post('/settings/connectors/nope/verify')).status).toBe(404);
  });
});

describe('rateLimit', () => {
  it('answers 429 with Retry-After once a client goes over the limit', async () => {
    const app = express();
    app.post('/x', rateLimit(2), (_req, res) => {
      res.status(204).end();
    });
    expect((await request(app).post('/x')).status).toBe(204);
    expect((await request(app).post('/x')).status).toBe(204);
    const limited = await request(app).post('/x');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('LOUSHO_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
