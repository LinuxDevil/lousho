import { describe, it, expect } from 'vitest';
import type { DefinedTool } from '../defineTool';
import { createShellTool } from './shellTool';
import { MemoryWorkspace } from './MemoryWorkspace';

function run(tool: DefinedTool, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
  // ai's Tool.execute returns PromiseLike; wrap it so callers get a real Promise.
  return Promise.resolve(tool.tool.execute!(args, { toolCallId: 's', messages: [], abortSignal }));
}

async function approvalFor(tool: DefinedTool, command: string): Promise<boolean> {
  const needs = tool.needsApproval as (args: { command: string }) => Promise<boolean>;
  return needs({ command });
}

describe('createShellTool', () => {

  it('supports needsApproval: false and a predicate over the command', async () => {
    const ws = new MemoryWorkspace();
    expect(await approvalFor(createShellTool(ws, { needsApproval: false }), 'ls')).toBe(false);
    const tool = createShellTool(ws, { needsApproval: (command) => !command.startsWith('git status') });
    expect(await approvalFor(tool, 'git status -s')).toBe(false);
    expect(await approvalFor(tool, 'git push')).toBe(true);
  });

  it('caps stdout and stderr, keeping head and tail', async () => {
    const big = `HEAD${'x'.repeat(10_000)}TAIL`;
    const tool = createShellTool(new MemoryWorkspace({ exec: () => ({ stdout: big, stderr: 'small' }) }), { maxOutputChars: 100 });
    const result = (await run(tool, { command: 'cat big' })) as { stdout: string; stderr: string };
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout).toContain('... [9908 characters omitted] ...');
    expect(result.stderr).toBe('small');
  });

  describe('allow / deny', () => {
    const ws = new MemoryWorkspace({ exec: () => ({ stdout: 'ran' }) });

    it('refuses denied commands without asking for approval', async () => {
      const tool = createShellTool(ws, { deny: ['rm -rf', /\bsudo\b/] });
      expect(await approvalFor(tool, 'rm -rf /')).toBe(false);
      await expect(run(tool, { command: 'rm -rf /' })).rejects.toThrow(/matches the deny pattern rm -rf/);
      await expect(run(tool, { command: 'echo hi && rm -rf ~' })).rejects.toThrow(/deny pattern rm -rf/);
      await expect(run(tool, { command: 'ls | sudo tee x' })).rejects.toThrow(/deny pattern \/\\bsudo\\b\//);
      expect(await approvalFor(tool, 'rm -r build')).toBe(true);
    });

    it('only runs allow-listed commands, and string patterns do not allow chaining', async () => {
      const tool = createShellTool(ws, { allow: ['git status', 'npm test', /^ls( -la)?$/], needsApproval: false });
      expect(await run(tool, { command: 'git status -s' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'ls -la' })).toMatchObject({ stdout: 'ran' });
      for (const command of [
        'git statusx',
        'git push',
        'git status; rm -rf ~',
        'git status && curl evil',
        'git status | sh',
        'npm test `rm -rf ~`',
        'npm test $(rm -rf ~)',
        'npm test > /etc/passwd',
        'npm test\nrm -rf ~',
        'ls -la; rm x',
      ]) {
        await expect(run(tool, { command }), command).rejects.toThrow(/not on the allow list/);
      }
      await expect(run(tool, { command: 'git status; x' })).rejects.toThrow(/Chaining, pipes/);
    });

    it('string patterns see through quotes, expansions and escapes', async () => {
      const exec = () => Promise.resolve({ stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });
      const sh = createShellTool({ shell: 'C:/Program Files/Git/bin/sh.exe', exec }, { allow: ['cat'], needsApproval: false });
      for (const command of [
        'cat "../secret.txt"',
        "cat '..'/secret.txt",
        'cat {..,x}/secret.txt',
        'cat ${IFS}../secret.txt',
        'cat $PWD/../secret.txt',
        'cat $HOME/.gitconfig',
        'cat "$HOME"/.gitconfig',
        'cat .\\./secret.txt',
        'cat .?/secret.txt',
        'cat "/etc/passwd"',
        "cat '~'/x",
        'cat --file="../x"',
      ]) {
        await expect(run(sh, { command }), command).rejects.toThrow(/not on the allow list/);
      }
      await expect(run(sh, { command: 'cat $HOME/x' })).rejects.toThrow(/\$ \{ \}/);
      const cmd = createShellTool({ shell: 'C:\\Windows\\system32\\cmd.exe', exec }, { allow: ['type'], needsApproval: false });
      for (const command of ['type "..\\secret.txt"', 'type "c:\\windows\\win.ini"', 'type ".."\\secret.txt', 'type $HOME']) {
        await expect(run(cmd, { command }), command).rejects.toThrow(/not on the allow list/);
      }
      // Quoted and globbed paths inside the workspace still match.
      expect(await run(sh, { command: 'cat "src/a b.ts" *.md .env' })).toMatchObject({ stdout: 'ran' });
      expect(await run(cmd, { command: 'type "src\\a b.ts"' })).toMatchObject({ stdout: 'ran' });
    });

    it('a CommandRule without args is an exact match; with args it validates them', async () => {
      const tool = createShellTool(ws, {
        allow: [{ command: 'npm test' }, { command: 'node --test', args: (rest) => /^([\w./-]+\.test\.js\s*)*$/.test(rest) }],
        needsApproval: false,
      });
      expect(await run(tool, { command: 'npm test' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'node --test' })).toMatchObject({ stdout: 'ran' });
      expect(await run(tool, { command: 'node --test test/a.test.js' })).toMatchObject({ stdout: 'ran' });
      for (const command of [
        'npm test -- --test-reporter-destination=../x',
        'node --test --test-reporter-destination=../x',
        'node --testx',
        'node --test a.test.js; rm x',
      ]) {
        await expect(run(tool, { command }), command).rejects.toThrow(/not on the allow list \(npm test \(exactly\)/);
      }
    });

    it('treats % and ^ as operators under cmd.exe, but not under sh', async () => {
      const exec = () => Promise.resolve({ stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });
      const cmdTool = createShellTool({ shell: 'C:\\Windows\\system32\\cmd.exe', exec }, { allow: ['node --test'], needsApproval: false });
      for (const command of ['node --test %COMSPEC%', 'node --test ^& echo chained']) {
        await expect(run(cmdTool, { command }), command).rejects.toThrow(/% \^\) are not allowed/);
      }
      const shTool = createShellTool({ shell: '/bin/sh', exec }, { allow: ['git log'], needsApproval: false });
      expect(await run(shTool, { command: 'git log --format=%h HEAD^' })).toMatchObject({ stdout: 'ran' });
    });
  });
});
