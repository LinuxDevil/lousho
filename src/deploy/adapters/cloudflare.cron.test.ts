/**
 * Cron triggers of the spec become `[triggers] crons` of the generated
 * wrangler.toml, and the built Worker bundle's `scheduled()` runs them.
 */
import { describe, it, expect,  } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SDKError } from '../../execution/errors';
import { CloudflareWorkerAdapter, workerCrons } from './cloudflare';

const SPEC = {
  name: 'cron-agent',
  prompt: 'You are a scheduled agent.',
  provider: { type: 'mock', model: 'mock-1' },
};
const trigger = (extra: Record<string, unknown>) => ({ type: 'cron', name: 'nightly', input: 'Run.', ...extra });

describe('wrangler.toml crons', () => {

  it.each([
    ['a numeric day-of-week', { cron: '0 9 * * 1' }],
  ])('fails with a coded SDK error naming the trigger for %s', (_label, extra) => {
    let thrown: unknown;
    try {
      workerCrons({ ...SPEC, triggers: [trigger(extra)] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SDKError);
    expect((thrown as SDKError).code).toBe('LOUSHO_SCHEDULE_INVALID');
    expect((thrown as SDKError).message).toContain("'nightly'");
  });

  it('scaffold() fails before writing anything for an unsupported expression', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-cron-bad-'));
    const specPath = path.join(dir, 'agent.json');
    fs.writeFileSync(specPath, JSON.stringify({ ...SPEC, triggers: [trigger({ cron: '0 0 9 * * *' })] }));
    await expect(CloudflareWorkerAdapter.scaffold(specPath, path.join(dir, 'out'))).rejects.toThrow(/nightly/);
    expect(fs.existsSync(path.join(dir, 'out', 'wrangler.toml'))).toBe(false);
  });
});
