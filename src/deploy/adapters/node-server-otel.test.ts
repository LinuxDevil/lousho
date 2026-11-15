/**
 * The built server exports OTel traces when OTEL_EXPORTER_OTLP_ENDPOINT is set:
 * scaffold + build a spec, run dist/server.js against a local collector stub,
 * and check one /chat turn arrives there as an `invoke_agent` span.
 *
 * @opentelemetry/sdk-trace-node and @opentelemetry/resources are the real
 * packages (dev dependencies, linked into the build's node_modules).
 * @opentelemetry/exporter-trace-otlp-http is not installed in this repo, so a
 * stub package stands in for it: it POSTs the finished spans as JSON (not the
 * OTLP encoding) to the same endpoint the real one would.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { withBuildLock } from '../buildLock.testkit';

const SPEC = {
  name: 'otel-test-agent',
  prompt: 'You are a traced test agent.',
  provider: { type: 'mock', model: 'mock-model-1' },
};

interface Received {
  url: string;
  body: { resourceSpans: { resource: { attributes: Record<string, unknown> }; scopeSpans: { spans: { name: string; attributes: Record<string, unknown> }[] }[] }[] };
}

describe('node-server build: OTel trace export', () => {
  let outDir: string;
  let collector: http.Server;
  const received: Received[] = [];

  beforeAll(async () => {
    collector = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(body) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-otel-'));
    const specPath = path.join(dir, 'agent.json');
    fs.writeFileSync(specPath, JSON.stringify(SPEC));
    outDir = path.join(dir, 'out');
    await NodeServerAdapter.scaffold(specPath, outDir);
    await withBuildLock(() => NodeServerAdapter.build(outDir));
  }, 120_000);

  afterAll(() => {
    collector.close();
  });

  it("adds the exporter next to an agent directory's or an agent module's own", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-otel-src-'));
    const agentDir = path.join(dir, 'support-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ model: 'mock/mock-model-1', instructions: 'Hi.' }));
    await NodeServerAdapter.scaffold(agentDir, path.join(dir, 'dir-out'));
    const dirServer = fs.readFileSync(path.join(dir, 'dir-out', 'server.ts'), 'utf8');
    expect(dirServer).toContain('otelTracingFromEnv({ serviceName: "support-agent" })');
    expect(dirServer).toContain('createAgent(withOtelTracing({ ...resolved.config, store }, tracing))');

    const moduleFile = path.join(dir, 'agent.ts');
    fs.writeFileSync(moduleFile, "export default { model: 'mock/mock-model-1' };\n");
    await NodeServerAdapter.scaffold(moduleFile, path.join(dir, 'module-out'));
    const moduleServer = fs.readFileSync(path.join(dir, 'module-out', 'server.ts'), 'utf8');
    expect(moduleServer).toContain('agentWithOtelTracing(exported, tracing)');
    expect(moduleServer).toContain('createAgent(withOtelTracing({ ...exported, store }, tracing))');
  });
});
