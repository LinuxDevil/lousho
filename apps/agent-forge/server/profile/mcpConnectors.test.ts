import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from '../secretsStore';
import { McpConnectorService, registerMcpConnectorRoutes } from './mcpConnectors';

let dir: string;
let file: string;
let secrets: SecretsStore;
let probe: ReturnType<typeof vi.fn>;
let service: McpConnectorService;
let app: Express;

const TOKEN = 'tok_supersecret';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-mcp-connectors-'));
  file = path.join(dir, 'connectors.json');
  secrets = new SecretsStore(dir);
  probe = vi.fn().mockResolvedValue({ ok: true, tools: [{ name: 'a', description: '' }, { name: 'b', description: '' }] });
  service = new McpConnectorService(file, secrets, probe as never);
  secrets.attachMcpConnectors(() => service.stored());
  app = express();
  app.use(express.json());
  registerMcpConnectorRoutes(app, service);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP connector routes', () => {
  it('adds, lists, verifies and removes a connector', async () => {
    const added = await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp', token: TOKEN });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: 'docs', url: 'https://mcp.example.com/mcp', hasToken: true, toolCount: 2 });
    expect(probe).toHaveBeenCalledWith({ url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(secrets.getSecret('MCP_DOCS_TOKEN')).toBe(`Bearer ${TOKEN}`);

    const list = await request(app).get('/settings/mcp-connectors');
    expect(list.body).toHaveLength(1);

    probe.mockResolvedValue({ ok: true, tools: [{ name: 'a', description: '' }] });
    const verified = await request(app).post('/settings/mcp-connectors/docs/verify');
    expect(verified.status).toBe(200);
    expect(verified.body.toolCount).toBe(1);
    expect(verified.body.error).toBeUndefined();

    const removed = await request(app).delete('/settings/mcp-connectors/docs');
    expect(removed.status).toBe(200);
    expect(secrets.getSecret('MCP_DOCS_TOKEN')).toBeUndefined();
    expect((await request(app).get('/settings/mcp-connectors')).body).toEqual([]);
    expect((await request(app).delete('/settings/mcp-connectors/docs')).status).toBe(404);
  });

  it('rejects the save with 422 and the probe message when the probe fails', async () => {
    probe.mockResolvedValue({ ok: false, error: `connect refused with Bearer ${TOKEN}` });
    const res = await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp', token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('connect refused');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect((await request(app).get('/settings/mcp-connectors')).body).toEqual([]);
    expect(secrets.getSecret('MCP_DOCS_TOKEN')).toBeUndefined();
  });

  it('records a failed re-check and keeps the connector', async () => {
    await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp' });
    probe.mockResolvedValue({ ok: false, error: 'The server did not answer within 10 seconds.' });
    const res = await request(app).post('/settings/mcp-connectors/docs/verify');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('The server did not answer within 10 seconds.');
    expect(res.body.toolCount).toBe(2);
    expect((await request(app).get('/settings/mcp-connectors')).body[0].error).toBe('The server did not answer within 10 seconds.');
    expect((await request(app).post('/settings/mcp-connectors/nope/verify')).status).toBe(404);
  });

  it('validates the name and the URL', async () => {
    expect((await request(app).put('/settings/mcp-connectors/Bad_Name').send({ url: 'https://x.example.com' })).status).toBe(422);
    expect((await request(app).put('/settings/mcp-connectors/docs').send({ url: 'ftp://x.example.com' })).status).toBe(422);
    expect((await request(app).put('/settings/mcp-connectors/docs').send({ url: 'http://x.example.com' })).status).toBe(422);
    expect((await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://user:pw@x.example.com' })).status).toBe(422);
    expect((await request(app).put('/settings/mcp-connectors/docs').send({ url: 'http://localhost:3000/mcp' })).status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored token when an update leaves it empty, and never returns a token', async () => {
    await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp', token: TOKEN });
    const updated = await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/v2' });
    expect(updated.body).toMatchObject({ hasToken: true, url: 'https://mcp.example.com/v2' });
    expect(probe).toHaveBeenLastCalledWith({ url: 'https://mcp.example.com/v2', headers: { Authorization: `Bearer ${TOKEN}` } });
    const responses = [updated.body, (await request(app).get('/settings/mcp-connectors')).body, (await request(app).post('/settings/mcp-connectors/docs/verify')).body];
    expect(JSON.stringify(responses)).not.toContain(TOKEN);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
  });

  it('shares the metadata file with the connected accounts without clobbering them', async () => {
    fs.writeFileSync(file, JSON.stringify({ github: { connectedAt: 'then', account: 'octo' } }));
    await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp' });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.github).toEqual({ connectedAt: 'then', account: 'octo' });
    expect(Object.keys(stored.mcp)).toEqual(['docs']);
  });

  it('exposes the stored connectors with a token secret name to runs', async () => {
    await request(app).put('/settings/mcp-connectors/docs').send({ url: 'https://mcp.example.com/mcp', token: TOKEN });
    await request(app).put('/settings/mcp-connectors/open-api').send({ url: 'https://open.example.com/mcp' });
    expect(secrets.mcpConnectors()).toEqual([
      { name: 'docs', url: 'https://mcp.example.com/mcp', tokenSecret: 'MCP_DOCS_TOKEN' },
      { name: 'open-api', url: 'https://open.example.com/mcp' },
    ]);
  });
});
