import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { hooksFromSpec } from './hooks';

const fixtures = path.join(__dirname, '..', '__fixtures__');

const redact = { id: 'redact', inline: { name: 'Redact PII', point: 'postToolCall', code: 'return ctx;' } } as const;

describe('hooksFromSpec file entries', () => {

  it('loads every hook a file default-exports, keeping their names', async () => {
    const hooks = await hooksFromSpec([{ id: 'h1', file: 'hooks/list.ts' }], { baseDir: fixtures });
    expect(hooks.map((hook) => hook.name)).toEqual(['a', 'b']);
  });

  it('rejects a file whose default export is not a hook', async () => {
    await expect(hooksFromSpec([{ id: 'h1', file: 'hooks/bad.ts' }], { baseDir: fixtures })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'hooks.0.file',
      message: expect.stringContaining('the default export must be a hook'),
    });
  });

  it('rejects a file that does not exist', async () => {
    await expect(hooksFromSpec([{ id: 'h1', file: 'hooks/missing.ts' }], { baseDir: fixtures })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'hooks.0.file',
      message: expect.stringContaining('does not exist'),
    });
  });
});

describe('hooksFromSpec inline entries', () => {

  it('rejects an inline entry when the host has no hook sandbox', async () => {
    await expect(hooksFromSpec([redact], {})).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'hooks.0',
      message: expect.stringContaining('inline code'),
    });
  });
});
