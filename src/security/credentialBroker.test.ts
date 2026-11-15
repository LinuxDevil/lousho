import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createCredentialBroker, CredentialBroker, CredentialBrokerOptions } from './credentialBroker';

/** A fake token planted for these tests only. */
const SECRET = 'fake-broker-secret-x12';
const LOOPBACK = '127.0.0.1';

let upstream: http.Server;
let upstreamHost: string;
const seen: http.IncomingHttpHeaders[] = [];
const brokers: CredentialBroker[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('connection', 'x-upstream-hop');
    res.setHeader('x-upstream-hop', 'drop-me');
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, LOOPBACK, resolve));
  upstreamHost = `${LOOPBACK}:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

afterEach(async () => {
  seen.length = 0;
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

/** A broker whose loopback test upstream is explicitly allowed to be private. */
async function broker(options: Partial<CredentialBrokerOptions> = {}): Promise<CredentialBroker> {
  const created = await createCredentialBroker({
    rules: { [LOOPBACK]: { authorization: () => `Bearer ${SECRET}`, 'x-static': 'static-value' } },
    allowPrivate: [LOOPBACK],
    pathFormScheme: 'http',
    ...options,
  });
  brokers.push(created);
  return created;
}

function proxyPort(b: CredentialBroker): number {
  return Number(new URL(b.url).port);
}

/** Sends `path` (absolute-URI or `/__broker/` form) to the proxy and reads the whole response. */
function viaProxy(b: CredentialBroker, target: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port: proxyPort(b), path: target, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens a CONNECT tunnel; resolves with the status and the tunnel socket. */
function connect(b: CredentialBroker, target: string) {
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port: proxyPort(b), method: 'CONNECT', path: target, agent: false });
    req.on('connect', (res: http.IncomingMessage, socket: Socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('error', reject);
    req.end();
  });
}

describe('createCredentialBroker', () => {
  it('injects rule headers into plain-HTTP requests, replacing a client Authorization and dropping hop-by-hop headers', async () => {
    const b = await broker();
    const res = await viaProxy(b, `http://${upstreamHost}/repos?x=1`, {
      authorization: 'Bearer client-supplied',
      connection: 'x-client-hop',
      'x-client-hop': 'drop-me',
      'proxy-authorization': 'Basic abc',
      'x-kept': 'yes',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: '/repos?x=1', authorization: `Bearer ${SECRET}` });
    expect(seen[0]).toMatchObject({ 'x-static': 'static-value', 'x-kept': 'yes', host: upstreamHost });
    expect(seen[0]).not.toHaveProperty('x-client-hop');
    expect(seen[0]).not.toHaveProperty('proxy-authorization');
    expect(res.headers).not.toHaveProperty('x-upstream-hop');
  });

  it('forwards allowlisted hosts without injecting anything, and answers 403 for any other host without connecting', async () => {
    const b = await broker({ rules: {}, allow: [LOOPBACK] });
    const res = await viaProxy(b, `http://${upstreamHost}/plain`, { authorization: 'Bearer own-token' });
    expect(JSON.parse(res.body)).toEqual({ path: '/plain', authorization: 'Bearer own-token' });

    const denied = await viaProxy(b, 'http://not-allowed.invalid/x');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatch(/not on the broker's allowlist/);
    expect(seen).toHaveLength(1);
  });

  it('serves /__broker/<host>/<path> with the injected headers', async () => {
    const b = await broker();
    expect(b.baseUrl(upstreamHost)).toBe(`${b.url}/__broker/${upstreamHost}`);
    const res = await viaProxy(b, `/__broker/${upstreamHost}/user/repos?page=2`);
    expect(JSON.parse(res.body)).toEqual({ path: '/user/repos?page=2', authorization: `Bearer ${SECRET}` });
    expect((await viaProxy(b, '/not-a-broker-path')).status).toBe(400);
  });

  it('refuses hosts that resolve to loopback or private addresses unless explicitly allowed', async () => {
    const b = await broker({ allowPrivate: [] });
    const res = await viaProxy(b, `http://${upstreamHost}/`);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/private address/);
    expect((await connect(b, `${upstreamHost}`)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('tunnels CONNECT to allowed targets untouched and refuses others', async () => {
    const b = await broker();
    const denied = await connect(b, 'evil.invalid:443');
    expect(denied.status).toBe(403);
    denied.socket.destroy();

    const { status, socket } = await connect(b, upstreamHost);
    expect(status).toBe(200);
    const reply = new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('}')) resolve(data);
      });
    });
    socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${upstreamHost}\r\nConnection: close\r\n\r\n`);
    const body = await reply;
    expect(body).toContain('"path":"/tunnelled"');
    expect(body).toContain('"authorization":null');
  });

  it('never exposes the secret: env, refusals and a failing credential function stay clean', async () => {
    const b = await broker({
      rules: { [LOOPBACK]: { authorization: () => { throw new Error(`token ${SECRET} expired`); } } },
    });
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(b.env).toMatchObject({ HTTP_PROXY: b.url, HTTPS_PROXY: b.url, NO_PROXY: LOOPBACK, http_proxy: b.url, https_proxy: b.url, no_proxy: LOOPBACK });
    expect(JSON.stringify(b.env)).not.toContain(SECRET);
    const res = await viaProxy(b, `http://${upstreamHost}/`);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(SECRET);
    expect(seen).toHaveLength(0);
  });

  it('validates host patterns', async () => {
    await expect(createCredentialBroker({ rules: { 'https://api.github.com/': {} } })).rejects.toThrow(/host/);
    await expect(createCredentialBroker({ rules: {}, allow: ['a..b'] })).rejects.toThrow(/host/);
  });

  describe('listen() on another address for one subnet', () => {
    /** Sends a plain-HTTP proxy request to `listenerUrl`; resolves with the status, or 'refused' when the connection is dropped. */
    function viaListener(listenerUrl: string, target: string) {
      const { hostname, port } = new URL(listenerUrl);
      return new Promise<number | 'refused'>((resolve) => {
        const req = http.request({ host: hostname, port: Number(port), path: target, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', () => resolve('refused'));
        req.end();
      });
    }

    it('serves peers inside the subnet with the rule hosts plus its own allow list, not the broker-wide allow list', async () => {
      const b = await broker({ allow: ['broker-wide.invalid'] });
      const listener = await b.listen({ host: LOOPBACK, clients: '172.30.0.0/16', allow: ['listener-only.invalid'], peerAddress: () => '172.30.0.7' });
      expect(listener.url).not.toBe(b.url);
      expect(listener.env).toMatchObject({ HTTP_PROXY: listener.url, HTTPS_PROXY: listener.url, NO_PROXY: LOOPBACK });
      expect(JSON.stringify(listener.env)).not.toContain(SECRET);

      expect(await viaListener(listener.url, `http://${upstreamHost}/via-listener`)).toBe(200);
      expect(seen[0].authorization).toBe(`Bearer ${SECRET}`);
      expect(await viaListener(listener.url, 'http://broker-wide.invalid/')).toBe(403);
      expect(await viaListener(listener.url, 'http://listener-only.invalid/')).toBe(502); // allowed, then fails to resolve
      expect(await viaListener(b.url, 'http://broker-wide.invalid/')).toBe(502); // the main listener is unchanged
    });

    it('drops a peer outside the subnet before reading its request', async () => {
      const b = await broker();
      const outside = await b.listen({ host: LOOPBACK, clients: '172.30.0.0/16', peerAddress: () => '10.1.2.3' });
      expect(await viaListener(outside.url, `http://${upstreamHost}/`)).toBe('refused');
      const ipv4Mapped = await b.listen({ host: LOOPBACK, clients: '172.30.0.0/16', peerAddress: () => '::ffff:172.30.9.9' });
      expect(await viaListener(ipv4Mapped.url, `http://${upstreamHost}/`)).toBe(200);
      const unknownPeer = await b.listen({ host: LOOPBACK, clients: '172.30.0.0/16', peerAddress: () => undefined });
      expect(await viaListener(unknownPeer.url, `http://${upstreamHost}/`)).toBe('refused');
      expect(seen).toHaveLength(1);
    });

    it('rejects a malformed subnet and an address it cannot bind', async () => {
      const b = await broker();
      for (const clients of ['172.30.0.0', '172.30.0.0/33', 'example.com/8', '10.0.0.0/8/1']) {
        await expect(b.listen({ host: LOOPBACK, clients })).rejects.toThrow(/subnet such as/);
      }
      await expect(b.listen({ host: '192.0.2.1', clients: '192.0.2.0/24' })).rejects.toThrow(/EADDRNOTAVAIL|EADDRINUSE|bind/i);
    });

    it('a listener closes on its own, and broker.close() closes the rest', async () => {
      const b = await createCredentialBroker({ rules: { [LOOPBACK]: {} }, allowPrivate: [LOOPBACK] });
      const first = await b.listen({ host: LOOPBACK, clients: '127.0.0.0/8' });
      const second = await b.listen({ host: LOOPBACK, clients: '127.0.0.0/8' });
      await first.close();
      expect(await viaListener(first.url, `http://${upstreamHost}/`)).toBe('refused');
      expect(await viaListener(b.url, `http://${upstreamHost}/`)).toBe(200);
      await b.close();
      expect(await viaListener(second.url, `http://${upstreamHost}/`)).toBe('refused');
      expect(await viaListener(b.url, `http://${upstreamHost}/`)).toBe('refused');
    });
  });
});
