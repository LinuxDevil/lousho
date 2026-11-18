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
import { ConnectorService } from './connectors';
import { InboundService, registerInboundRoutes } from './inbound';
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
  const github = CONNECTORS.find((c) => c.id === 'github')!;
  const atlassian = CONNECTORS.find((c) => c.id === 'atlassian')!;

  it('verifies a token before saving it and reports the account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: 'octo' }), { headers: { 'x-oauth-scopes': 'repo, read:org' } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectorService(path.join(dir, 'connectors.json'), secrets);
    const { status } = await service.connect(github, { values: { token: 'ghp_x' } });
    expect(status).toMatchObject({ connected: true, account: 'octo', scopes: ['repo', 'read:org'] });
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_x');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_x');
  });

  it('saves nothing when the service rejects the credentials, and keeps saved values on reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const service = new ConnectorService(path.join(dir, 'connectors.json'), secrets);
    await expect(service.connect(atlassian, { values: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' } })).rejects.toThrow(/rejected/);
    expect(secrets.getSecret('JIRA_API_TOKEN')).toBeUndefined();

    secrets.setSecret('JIRA_API_TOKEN', 'kept');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ displayName: 'Ann' })));
    vi.stubGlobal('fetch', fetchMock);
    const { status } = await service.connect(atlassian, { values: { baseUrl: 'https://x.atlassian.net/', email: 'a@b.c', apiToken: '' } });
    expect(status).toMatchObject({ connected: true, account: 'Ann · x.atlassian.net' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.atlassian.net/rest/api/3/myself');
    expect(secrets.getSecret('JIRA_API_TOKEN')).toBe('kept');

    expect(service.disconnect(atlassian).connected).toBe(false);
    expect(secrets.getSecret('JIRA_BASE_URL')).toBeUndefined();
  });
});
