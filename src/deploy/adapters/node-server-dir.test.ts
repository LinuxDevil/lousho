/**
 * The node-server (and docker) targets deploy an agent directory:
 * scaffold + tsup build + the built dist/server.js as a real subprocess that
 * mounts the directory's channels and reports its schedules. Only the LLM is
 * the SDK's mock provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeServerAdapter } from './node-server';
import { copyAgentDirAssets } from './node-server-dir';
import { withBuildLock } from '../buildLock.testkit';

const FILES: Record<string, string> = {
  'instructions.md': 'You are a deployed agent directory.\n',
  'agent.ts': `import { createMockProvider } from 'lousho';
export default { provider: createMockProvider({ name: 'mock', responses: ['pong'] }) };
`,
  'schedules/daily.ts': `import { defineSchedule } from 'lousho';
export default defineSchedule({ cron: '0 9 * * *', prompt: 'Good morning' });
`,
  'auth.ts': `import { apiToken, basic } from 'lousho/auth';
export default [basic({ users: { ops: 'pw' } }), apiToken('dir-token', { id: 'ci' })];
`,
  'channels/echo.ts': `import { defineChannel } from 'lousho';
export default defineChannel({
  name: 'echo',
  async parse(req) { return { sessionKey: 'k', input: req.text, replyTo: null }; },
  async reply({ text, respond }) { respond?.(200, { reply: text }); },
});
`,
  // Assets the server reads: copied.
  'instructions/claude.md': 'Claude-specific tail.\n',
  'skills/release/SKILL.md': '---\ndescription: Steps for cutting a release\n---\n1. Tag it.\n',
  'subagents/helper/agent.json': '{ "description": "Helps out" }\n',
  'subagents/helper/instructions.md': 'You help.\n',
  // Never copied: secrets, the session store, anything else in the directory.
  '.env': 'OPENAI_API_KEY=sk-secret\n',
  '.env.local': 'TOKEN=secret\n',
  '.lousho/sessions/old.json': '{"messages":["a real user transcript"]}\n',
  'skills/release/.env': 'SKILL_KEY=secret\n',
  'subagents/helper/.env': 'SUB_KEY=secret\n',
  'subagents/helper/.lousho/sessions/s.json': '{}\n',
  'notes.txt': 'private notes\n',
};

/** Every file under `dir`, relative and with forward slashes. */
function listFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'));
}

function writeAgentDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-agent-dir-')), 'my-agent');
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('NodeServerAdapter with an agent directory', () => {
  let agentDir: string;
  let outDir: string;

  beforeAll(async () => {
    agentDir = writeAgentDir();
    outDir = path.join(path.dirname(agentDir), 'out');
    await NodeServerAdapter.scaffold(agentDir, outDir);
    // A store an earlier build's server wrote under dist/agent must not survive the rebuild.
    fs.mkdirSync(path.join(outDir, 'dist', 'agent', '.lousho', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'dist', 'agent', '.lousho', 'sessions', 'stale.json'), '{}');
    await withBuildLock(() => NodeServerAdapter.build(outDir));
  }, 120_000);
  afterAll(() => {
    if (agentDir) fs.rmSync(path.dirname(agentDir), { recursive: true, force: true });
  });

  it("leaves out a JSON/YAML config's store.dir even inside a copied folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-store-dir-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ instructions: 'hi', store: { dir: './skills/state' } }));
      fs.mkdirSync(path.join(dir, 'skills', 'state', 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'state', 'sessions', 's.json'), '{}');
      fs.mkdirSync(path.join(dir, 'skills', 'greet'));
      fs.writeFileSync(path.join(dir, 'skills', 'greet', 'SKILL.md'), '---\ndescription: Greets\n---\nSay hi.\n');
      const out = path.join(dir, 'out');
      await copyAgentDirAssets(dir, out);
      expect(listFiles(path.join(out, 'dist')).sort()).toEqual(['agent/agent.json', 'agent/skills/greet/SKILL.md', 'package.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
