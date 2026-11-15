/**
 * #291: openApiTools({ privateAddresses: 'refuse' }) refuses private
 * destinations with the pinned DNS lookup `http_request` and `web_fetch` use
 * (src/security/privateAddress.ts). The resolver is stubbed; the "private"
 * target is a local node:http server on 127.0.0.1 that counts every TCP
 * connection, so a request that reaches it (even a TLS handshake it cannot
 * read) is seen. Fully offline.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import petstore from './__fixtures__/petstore.json';
import { openApiTools, type OpenApiToolsOptions } from './openApiTools';
import { ConfigurationError } from '../../execution/errors';
import type { DefinedTool } from '../defineTool';
import type { ToolExecutionContext } from '../../types';

let server: http.Server;
let port: number;
let connections = 0;
let seen: Array<{ url: string; host: string }> = [];

const realLookup = dns.promises.lookup.bind(dns.promises) as (hostname: string, options: dns.LookupOptions) => Promise<unknown>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    seen.push({ url, host: req.headers.host ?? '' });
    if (url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(petstore));
    }
    if (url.startsWith('/redirect-to-literal')) {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/openapi.json` });
      return void res.end();
    }
    if (url.startsWith('/redirect-to-name')) {
      res.writeHead(302, { location: `https://internal.test:${port}/openapi.json` });
      return void res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url }));
  });
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let answers: Record<string, () => string>;
let lookups: string[];

beforeEach(() => {
  connections = 0;
  seen = [];
  lookups = [];
  answers = { localhost: () => '127.0.0.1' };
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string, options?: dns.LookupOptions) => {
    lookups.push(hostname);
    const answer = answers[hostname];
    if (!answer) return realLookup(hostname, options ?? {});
    const address = answer();
    const entry = { address, family: address.includes(':') ? 6 : 4 };
    return options?.all ? [entry] : entry;
  }) as unknown as typeof dns.promises.lookup);
  // A second resolution through the callback API would be the rebinding bug; fail it loudly.
  const actualLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback?: unknown) => {
    if (!answers[hostname]) return (actualLookup as (...a: unknown[]) => void)(hostname, options, callback);
    lookups.push(`callback:${hostname}`);
    const cb = (typeof options === 'function' ? options : callback) as (e: Error | null, a: unknown, f?: number) => void;
    const address = answers[hostname]();
    const family = address.includes(':') ? 6 : 4;
    if ((options as dns.LookupOptions | undefined)?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as typeof dns.lookup);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ctx = { toolCallId: 'call_1', messages: [] } as unknown as ToolExecutionContext;
const REFUSE: OpenApiToolsOptions = { privateAddresses: 'refuse' };

async function tools(options: OpenApiToolsOptions, document: object | string | URL = petstore): Promise<Record<string, DefinedTool>> {
  const list = await openApiTools(document, { ...REFUSE, ...options });
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

describe("privateAddresses: 'refuse' - operation requests", () => {

  it('refuses a name that resolves to an IPv4-mapped IPv6 loopback address', async () => {
    answers['mapped.test'] = () => '::ffff:127.0.0.1';
    const all = await tools({ baseUrl: `https://mapped.test:${port}/v1` });
    await expect(all.listPets.execute({}, ctx)).rejects.toThrow(/refused: mapped\.test/);
    expect(connections).toBe(0);
  });

  it('DNS rebinding: a name that answers public first and 127.0.0.1 second never reaches the local server', async () => {
    // One answer sequence for both resolver APIs: an implementation that
    // resolves once to check and again to connect would check 203.0.113.10
    // and connect to 127.0.0.1.
    let count = 0;
    answers['rebind.test'] = () => (count++ === 0 ? '203.0.113.10' : '127.0.0.1');
    const all = await tools({ baseUrl: `https://rebind.test:${port}/v1`, timeoutMs: 1000 });
    await expect(all.listPets.execute({}, ctx)).rejects.toThrow(/GET \/pets/);
    expect(connections).toBe(0);
    expect(count).toBe(1);
    expect(lookups).toEqual(['rebind.test']);
  });
});

describe("privateAddresses: 'refuse' - addresses refused when the tools are made", () => {
  const literals = [
    'http://127.0.0.1:3000/v1',
    'https://2130706433/v1', // decimal 127.0.0.1
    'https://0x7f000001/v1', // hex
    'https://017700000001/v1', // octal
    'https://0177.0.0.1/v1',
    'https://127.1/v1',
    'https://0.0.0.0/v1',
    'https://10.0.0.1/v1',
    'https://169.254.169.254/latest',
    'http://[::1]:3000/v1',
    'https://[::]/v1',
    'https://[::ffff:127.0.0.1]/v1', // IPv4-mapped IPv6
    'https://[::ffff:a9fe:a9fe]/v1', // mapped 169.254.169.254, hex form
    'https://[fd00::1]/v1',
    'http://localhost:3000/v1',
    'http://LOCALHOST:3000/v1',
    'https://localhost./v1',
    'https://api.localhost/v1',
  ];

  for (const baseUrl of literals) {
    it(`refuses ${baseUrl}`, async () => {
      const error = await openApiTools(petstore, { ...REFUSE, baseUrl }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toMatch(/the base URL .*is or resolves to a loopback, link-local or private address/);
    });
  }

  it("refuses a server URL whose template variable defaults to a private address (the model never sets server variables)", async () => {
    const doc = { ...petstore, servers: [{ url: 'https://{host}/v1', variables: { host: { default: '169.254.169.254' } } }] };
    await expect(openApiTools(doc, REFUSE)).rejects.toThrow(/169\.254\.169\.254 is or resolves to/);
  });
});

describe("privateAddresses: 'refuse' - the document fetch", () => {

  it('checks every redirect hop: a literal and a name that resolves privately', async () => {
    answers['internal.test'] = () => '127.0.0.1';
    const options = { ...REFUSE, allowPrivate: ['localhost'] };
    await expect(openApiTools(`http://localhost:${port}/redirect-to-literal`, options)).rejects.toThrow(/a redirect of the document URL .*127\.0\.0\.1 is or resolves to/);
    await expect(openApiTools(`http://localhost:${port}/redirect-to-name`, options)).rejects.toThrow(/internal\.test is or resolves to/);
    expect(seen.map((s) => s.url)).toEqual(['/redirect-to-literal', '/redirect-to-name']);
  });
});

describe("privateAddresses: 'refuse' - configuration", () => {

  it('refuses allowPrivate without refuse, an invalid pattern and an unknown mode', async () => {
    await expect(openApiTools(petstore, { baseUrl: 'https://api.example.com', allowPrivate: ['localhost'] })).rejects.toThrow(/allowPrivate.*privateAddresses: 'refuse'/);
    await expect(openApiTools(petstore, { ...REFUSE, baseUrl: 'https://api.example.com', allowPrivate: ['not a host'] })).rejects.toThrow(/allowPrivate/);
    await expect(
      openApiTools(petstore, { baseUrl: 'https://api.example.com', privateAddresses: 'block' as unknown as 'refuse' })
    ).rejects.toThrow(/privateAddresses/);
  });

  it('fails at creation with a configuration error where undici (Node) cannot load', async () => {
    vi.resetModules();
    vi.doMock('undici', () => {
      throw new Error('no undici on this runtime');
    });
    try {
      const fresh = (await import('./openApiTools')).openApiTools;
      const error = await fresh(petstore, { ...REFUSE, baseUrl: 'https://api.example.com' }).catch((e: unknown) => e);
      expect((error as Error).name).toBe('ConfigurationError');
      expect((error as Error).message).toMatch(/privateAddresses: 'refuse' needs Node\.js/);
    } finally {
      vi.doUnmock('undici');
      vi.resetModules();
    }
  });
});
