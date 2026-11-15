import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveOpenApiRef } from './integrationTools';

describe('resolveOpenApiRef', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Orders', version: '1.0.0' },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/refunds': {
        post: {
          operationId: 'refund',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };

  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(document));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("honours the ref's own approval 'never'", async () => {
    const tools = await resolveOpenApiRef({ openapi: { url, approval: 'never' } }, {}, 'tools.0');
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools['refund']?.needsApproval).toBeFalsy();
  });

  it('fails at build time when the bearer token secret is missing', async () => {
    await expect(
      resolveOpenApiRef({ openapi: { url, bearerToken: { env: 'LOUSHO_TEST_MISSING_TOKEN' } } }, { env: {} }, 'tools.0')
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_SECRET_MISSING', field: 'tools.0.openapi.bearerToken' });
  });
});
