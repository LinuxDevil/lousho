import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listBuiltinTools } from './catalog';
import { BUILTIN_TOOL_FACTORIES } from './builtinRegistry';

describe('listBuiltinTools', () => {

  it('splits the workspace builtins into read-only, write and shell groups', () => {
    const byName = Object.fromEntries(listBuiltinTools().map((t) => [t.name, t]));
    expect(byName.workspace_read).toMatchObject({ mutating: false, toolNames: ['read_file', 'list_dir', 'glob', 'grep'] });
    expect(byName.workspace_write).toMatchObject({ mutating: true, toolNames: ['write_file', 'edit_file'] });
    expect(byName.shell).toMatchObject({ mutating: true, toolNames: ['shell'] });
  });

  it('confines workspace_read to its root option', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-ws-'));
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
      const tools = BUILTIN_TOOL_FACTORIES.workspace_read({ root });
      const read = (tools.read_file as unknown as { execute: (input: unknown) => Promise<unknown> }).execute;
      expect(JSON.stringify(await read({ path: 'a.txt' }))).toContain('hello');
      await expect(read({ path: '../outside.txt' })).rejects.toThrow();
      fs.mkdirSync(path.join(root, '.lousho'));
      fs.writeFileSync(path.join(root, '.lousho', 'secrets.key'), 'k');
      await expect(read({ path: '.lousho/secrets.key' })).rejects.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
