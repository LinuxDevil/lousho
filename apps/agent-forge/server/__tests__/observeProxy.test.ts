/**
 * `/observe/**` -> the observe daemon: the studio server forwards the
 * panels' GETs same-origin, because the daemon itself serves no CORS
 * headers. A dead daemon answers 502 with the `lousho observe start` hint.
 * Writes go through only when OBSERVE_WRITE_ALLOWLIST names the method and
 * path (feedback scores, a prompt label move, a hub publish, dataset and
 * example writes, annotation queue writes, evaluator rule writes); every
 * other non-GET stays 405.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../app';
import { observeUpstreamUrl } from '../observeProxy';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';

describe('observe proxy', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let daemon: http.Server | undefined;
  let daemonUrl: string;
  let lastDelete: { url: string | undefined; contentType: string | null; body: string } | undefined;
  let lastHeaders: http.IncomingHttpHeaders | undefined;
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  const prevToken = process.env.LOUSHO_OBSERVE_TOKEN;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-observe-proxy-test-'));
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir });

    // A stand-in for `lousho observe`: echoes the method, path, content-type and body it was sent.
    daemon = http.createServer((req, res) => {
      lastHeaders = req.headers;
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        // A code rule, so judge.ts's test route (registered before the proxy) forwards its /test here.
        if (req.method === 'GET' && req.url === '/api/v1/evaluators/r1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ evaluator: { rule_id: 'r1', kind: 'code' } }));
          return;
        }
        if (req.method === 'DELETE') {
          lastDelete = { url: req.url, contentType: req.headers['content-type'] ?? null, body };
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            echoed: req.url,
            method: req.method,
            contentType: req.headers['content-type'] ?? null,
            body: body ? JSON.parse(body) : null,
          }),
        );
      });
    });
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
    if (prevToken === undefined) delete process.env.LOUSHO_OBSERVE_TOKEN;
    else process.env.LOUSHO_OBSERVE_TOKEN = prevToken;
    daemon?.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("does not forward the browser's Origin, Sec-Fetch-* or Referer upstream (the daemon refuses cross-origin writes)", async () => {
    const res = await request(app)
      .post('/observe/api/v1/evaluators')
      .set('Host', 'localhost:5173')
      .set('Origin', 'http://localhost:5173')
      .set('Referer', 'http://localhost:5173/evaluators')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Sec-Fetch-Mode', 'cors')
      .send({ name: 'r', kind: 'code' });
    expect(res.status).toBe(201);
    expect(lastHeaders?.['content-type']).toBe('application/json');
    for (const header of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest']) expect(lastHeaders?.[header]).toBeUndefined();
  });

  it('forwards DELETE /api/v1/datasets/:name/examples/:id with no body and passes the 204 back', async () => {
    lastDelete = undefined;
    const res = await request(app).delete('/observe/api/v1/datasets/golden/examples/e1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(lastDelete).toEqual({ url: '/api/v1/datasets/golden/examples/e1', contentType: null, body: '' });
  });

  it('leaves POST /api/v1/evaluators/:id/test to the Studio route, which forwards a code rule to the daemon', async () => {
    const res = await request(app).post('/observe/api/v1/evaluators/r1/test').send({ trace_id: 't1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ echoed: '/api/v1/evaluators/r1/test', method: 'POST', body: { trace_id: 't1' } });
  });

  it.each([
    ['delete', '/observe/api/v1/prompts'],
    ['head', '/observe/api/v1/scores'],
    ['post', '/observe/v1/traces'],
  ] as const)('keeps %s %s at 405', async (method, url) => {
    const pending = request(app)[method](url);
    const res = method === 'head' ? await pending : await pending.send({ version: 1 });
    expect(res.status).toBe(405);
  });

  it.each([
    '/observe/api/v1/prompts/%2e%2e/labels/x',
    '/observe/api/v1/prompts/a%5cb/labels/x',
  ])('keeps an allowlisted shape with a dot, encoded-slash or undecodable segment at 405: %s', async (url) => {
    const res = await request(app).put(url).send({ version: 1 });
    expect(res.status).toBe(405);
  });

  it('rejects an allowlisted write whose body is over 1 MiB with 413', async () => {
    const res = await request(app)
      .put('/observe/api/v1/prompts/mira/labels/prod')
      .send({ version: 1, pad: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
  });
});

/**
 * The proxy behind the real token gate, over real sockets: the upstream is
 * built from the routed path and query only (never the request line's
 * authority), always lands on the observe target's origin, carries
 * `LOUSHO_OBSERVE_TOKEN` as the daemon bearer when set, and never forwards
 * the client's own credentials.
 */
describe('observe proxy (upstream origin and credentials)', () => {
  const TOKEN = 'proxy-studio-token-0123456789';
  let baseDir: string;
  let studio: http.Server;
  let studioPort: number;
  let daemon: http.Server;
  let daemonUrl: string;
  let evil: http.Server;
  let evilPort: number;
  let daemonSeen: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string }[];
  let evilSeen: string[];
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  const prevToken = process.env.LOUSHO_OBSERVE_TOKEN;

  async function listen(server: http.Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as net.AddressInfo).port;
  }

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-observe-proxy-origin-'));
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    daemonSeen = [];
    evilSeen = [];
    daemon = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        daemonSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ daemon: true, url: req.url }));
      });
    });
    evil = http.createServer((req, res) => {
      evilSeen.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ evil: true }));
    });
    daemonUrl = `http://127.0.0.1:${await listen(daemon)}`;
    evilPort = await listen(evil);
    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
    delete process.env.LOUSHO_OBSERVE_TOKEN;
    studio = http.createServer(createApp({ agentStore, runManager, baseDir, access: { token: TOKEN } }));
    studioPort = await listen(studio);
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
    if (prevToken === undefined) delete process.env.LOUSHO_OBSERVE_TOKEN;
    else process.env.LOUSHO_OBSERVE_TOKEN = prevToken;
    for (const server of [studio, daemon, evil]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** One raw HTTP/1.1 request (any request-target form) with the studio token and a loopback Host; the status and body. */
  function raw(method: string, target: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(studioPort, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]);
        resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
      });
      socket.on('error', reject);
      const lines = [
        `${method} ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${studioPort}`,
        `${STUDIO_TOKEN_HEADER}: ${TOKEN}`,
        'Connection: close',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
  }

  it.each([
    () => `http://a@127.0.0.1:${evilPort}/observe/api/v1/traces?limit=1`,
  ])('an absolute-form request line only ever reaches the observe target (#%#)', async (target) => {
    const res = await raw('GET', target());
    expect(evilSeen).toEqual([]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ daemon: true, url: '/api/v1/traces?limit=1' });
    expect(daemonSeen.map((seen) => seen.url)).toEqual(['/api/v1/traces?limit=1']);
  });

  it('fetches only URLs on the observe target origin for an absolute-form line with userinfo', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      fetched.push(String(input));
      return realFetch(input, init);
    });
    try {
      await raw('GET', 'http://a@evil.example/observe/api/v1/traces');
      await raw('GET', `http://a@127.0.0.1:${evilPort}/observe/api/v1/traces`);
    } finally {
      spy.mockRestore();
    }
    expect(fetched.map((url) => new URL(url).origin)).toEqual([daemonUrl, daemonUrl]);
    expect(fetched.map((url) => new URL(url).username)).toEqual(['', '']);
  });

  it.each([
    () => `/observe//127.0.0.1:${evilPort}/api/v1/traces`,
  ])('a path or query naming another host stays on the observe target (#%#)', async (target) => {
    await raw('GET', target());
    expect(evilSeen).toEqual([]);
    expect(daemonSeen).toHaveLength(1);
  });

  it.each([
    ['DELETE', '/observe/api/v1/datasets/x/examples/a\\..\\..\\..\\..\\..\\..\\api\\v1\\prompts\\mira'],
    ['PUT', '/observe/api/v1/prompts/mi\\ra/labels/prod'],
  ])('a literal backslash in an allowlisted write segment is refused before any fetch: %s %s', async (method, target) => {
    const res = await raw(method, target, { 'Content-Type': 'application/json', 'Content-Length': '2' }, '{}');
    expect(res.status).toBe(405);
    expect(daemonSeen).toEqual([]);
  });

  it('a backslash dot-segment write against a base-path target with the daemon token set never reaches the daemon', async () => {
    process.env.LOUSHO_OBSERVE_URL = `${daemonUrl}/base`;
    process.env.LOUSHO_OBSERVE_TOKEN = 'daemon-token-abc';
    const res = await raw('DELETE', '/observe/api/v1/datasets/x/examples/a\\..\\..\\..\\..\\..\\..\\api\\v1\\prompts\\mira');
    expect(res.status).toBe(405);
    expect(daemonSeen).toEqual([]);
  });

  it.each([
    '/observe/\\\\127.0.0.1:1/api/v1/traces',
    '/observe/api/v1/..',
  ])('a read whose path URL normalisation would rewrite answers 400 without a fetch: %s', async (target) => {
    const res = await raw('GET', target);
    expect(res.status).toBe(400);
    expect(daemonSeen).toEqual([]);
  });

  it('the query is taken from before a fragment, never from inside it', async () => {
    await raw('GET', `/observe/api/v1/traces#?@127.0.0.1:${evilPort}`);
    expect(evilSeen).toEqual([]);
    expect(daemonSeen.map((seen) => seen.url)).not.toContain(`/api/v1/traces?@127.0.0.1:${evilPort}`);
    for (const seen of daemonSeen) expect(seen.url).not.toContain('?');
  });

  it('sends no bearer to the daemon when LOUSHO_OBSERVE_TOKEN is unset, and never the client credentials', async () => {
    await raw('GET', '/observe/api/v1/traces', { Authorization: `Bearer ${TOKEN}`, Cookie: `lousho_studio_token=${TOKEN}` });
    expect(daemonSeen).toHaveLength(1);
    const { headers } = daemonSeen[0];
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers[STUDIO_TOKEN_HEADER]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
  });

  it('forwards LOUSHO_OBSERVE_TOKEN as the daemon bearer on reads and writes, never the Studio token', async () => {
    process.env.LOUSHO_OBSERVE_TOKEN = 'daemon-token-abc';
    await raw('GET', '/observe/api/v1/traces', { Authorization: `Bearer ${TOKEN}` });
    const score = { trace_id: 't1', name: 'feedback', value: 1 };
    const write = await request(studio)
      .post('/observe/api/v1/scores')
      .set(STUDIO_TOKEN_HEADER, TOKEN)
      .set('Host', `127.0.0.1:${studioPort}`)
      .send(score);
    expect(write.status).toBe(201);
    expect(daemonSeen.map((seen) => seen.headers.authorization)).toEqual(['Bearer daemon-token-abc', 'Bearer daemon-token-abc']);
    for (const seen of daemonSeen) {
      expect(seen.headers[STUDIO_TOKEN_HEADER]).toBeUndefined();
      expect(JSON.stringify(seen.headers)).not.toContain(TOKEN);
    }
  });
});

describe('observeUpstreamUrl', () => {
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
  });

  it.each(['@evil.example/api', '.evil.example/api', '/api/%2e%2e/%2e%2e/x', '/api\\..\\x',])(
    'refuses a path that would leave the target origin or that URL parsing would rewrite: %s',
    (routed) => {
      process.env.LOUSHO_OBSERVE_URL = 'http://127.0.0.1:7777/base';
      expect(observeUpstreamUrl(routed, '')).toBeUndefined();
    },
  );
});
