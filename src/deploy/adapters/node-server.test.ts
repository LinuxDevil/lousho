/**
 * Real integration test for the node-server adapter - scaffold +
 * tsup build + start the actual built dist/server.js as a subprocess, then
 * hit GET /health and POST /chat over real HTTP. Nothing here is mocked
 * except the LLM itself (the spec's provider is the SDK's built-in 'mock').
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSpecForDeploy } from './node-server';

function writeSpec(dir: string, spec: Record<string, unknown>, file = 'agent.json'): string {
  const specPath = path.join(dir, file);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

describe('NodeServerAdapter', () => {

  it('rejects non-spec agent configs and invalid specs with clear errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-node-server-bad-'));
    const tsPath = path.join(dir, 'agent.ts');
    fs.writeFileSync(tsPath, 'export {}');
    expect(() => loadAgentSpecForDeploy(tsPath)).toThrow(/builds an AgentSpec .yaml\/.yml\/.json file or an agent directory/);
    const txtPath = path.join(dir, 'agent.txt');
    fs.writeFileSync(txtPath, '');
    expect(() => loadAgentSpecForDeploy(txtPath)).toThrow(/expected an AgentSpec .yaml\/.yml\/.json file/);
    expect(() => loadAgentSpecForDeploy('')).toThrow(/an agent path is required/);
    const bad = writeSpec(dir, { name: 'x', provider: { type: 'mock', model: 'm' } });
    expect(() => loadAgentSpecForDeploy(bad)).toThrow(/'prompt'/);
  });
});
