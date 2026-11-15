/**
 * Docker adapter.
 *
 * Always runs: Dockerfile content checks, and spy assertions proving
 * scaffold()/build() delegate to NodeServerAdapter rather than duplicating
 * its logic.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerAdapter, DOCKERFILE } from './docker';
import { NodeServerAdapter, deployDependencies } from './node-server';

function writeSpec(dir: string): string {
  const specPath = path.join(dir, 'agent.yaml');
  fs.writeFileSync(
    specPath,
    'name: docker-agent\nprompt: You are a containerized agent.\nprovider:\n  type: mock\n  model: mock-1\n'
  );
  return specPath;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DockerAdapter', () => {

  it('scaffold() delegates to NodeServerAdapter.scaffold() and adds a Dockerfile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-docker-'));
    const specPath = writeSpec(dir);
    const outDir = path.join(dir, 'out');
    const spy = vi.spyOn(NodeServerAdapter, 'scaffold');

    await DockerAdapter.scaffold(specPath, outDir);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(specPath, outDir, undefined);
    // NodeServerAdapter's own outputs are there (written by it, not duplicated here)...
    for (const file of ['server.ts', 'agent.config.js', 'package.json']) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true);
    }
    // ...plus the Dockerfile.
    const dockerfile = fs.readFileSync(path.join(outDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toBe(DOCKERFILE);
    // A local .env or a packed SDK tarball in the build folder (--out=.) never reaches the image.
    expect(fs.readFileSync(path.join(outDir, '.dockerignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['.env', '.env.*', '**/.env', '**/.env.*', '**/.lousho', '*.tgz']));
    const lines = dockerfile.split('\n');
    expect(lines).toContain('FROM node:22-slim');
    expect(lines).toContain('WORKDIR /app');
    expect(lines).toContain('COPY dist/ ./dist/');
    // An optional lockfile makes the install reproducible (npm ci); without one it falls back to npm install.
    expect(lines).toContain('COPY package.json package-lock.json* ./');
    expect(lines).toContain('RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force');
    // Not root.
    expect(lines).toContain('USER node');
    expect(lines).toContain('EXPOSE 3000');
    expect(lines).toContain('CMD ["node", "dist/server.js"]');
    // The slim image has no curl: the health check probes /health with Node.
    expect(DOCKERFILE).toMatch(/^HEALTHCHECK .*\\\n\s+CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT \|\| 3000\) \+ '\/health'\)/m);
    // Container needs an explicit all-interfaces opt-in to be reachable via -p.
    expect(lines).toContain('ENV HOST=0.0.0.0');
  });

  it('deployDependencies pairs the provider peer with the installed ai major', () => {
    const deps = deployDependencies('openai');
    expect(deps['@ai-sdk/openai']).toMatch(/^\^/);
    expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
    expect(deployDependencies('nope')).toEqual(deployDependencies());
    const ollamaMcp = deployDependencies('ollama', true);
    expect(Object.keys(ollamaMcp)).toHaveLength(2);
    expect(Object.keys(ollamaMcp).some((k) => k.startsWith('ollama-ai-provider'))).toBe(true);
    expect(ollamaMcp['@modelcontextprotocol/sdk']).toBeDefined();
  });
});
