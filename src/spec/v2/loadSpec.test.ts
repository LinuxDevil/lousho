import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpecV2 } from './loadSpec';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-specv2-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('loadSpecV2', () => {

  it('loads a v1 spec using only the landed sections (askQuestion, compaction, mcpServers)', () => {
    const filePath = tmpFile(
      'agent.yaml',
      'name: bot\nprompt: Hi\nprovider: { type: mock, model: m }\n' +
        'policy: { askQuestion: true, compaction: { thresholdPercent: 0.8 } }\n' +
        'mcpServers: { fs: { command: npx } }\n'
    );
    const spec = loadSpecV2(filePath);
    expect(spec.askQuestion).toBe(true);
    expect(spec.compaction).toEqual({ thresholdPercent: 0.8 });
    expect(spec.mcpServers).toEqual({ fs: { command: 'npx' } });
  });
});
