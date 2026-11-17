import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { startStudioServer } from '../index';

describe('studio close()', () => {
  it('finishes while a browser tab still holds a WebSocket open', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-shutdown-test-'));
    const handle = await startStudioServer({ baseDir, port: 0, observe: false });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/agents/x/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const outcome = await Promise.race([
      handle.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    fs.rmSync(baseDir, { recursive: true, force: true });
    expect(outcome).toBe('closed');
  });
});
