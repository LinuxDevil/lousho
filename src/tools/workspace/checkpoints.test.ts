import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { mockModel, type MockTurn } from '../../testing';
import { createFsTools } from './fsTools';
import { MemoryWorkspace } from './MemoryWorkspace';
import { MemoryWorkspaceCheckpointStore, WorkspaceCheckpoints, type WorkspaceCheckpointsOptions } from './checkpoints';
import { WorkspaceError } from './paths';

type Call = { name: string; args: Record<string, unknown> };
const write = (path: string, content: string): Call => ({ name: 'write_file', args: { path, content } });
const edit = (path: string, old_string: string, new_string: string): Call => ({ name: 'edit_file', args: { path, old_string, new_string } });

/** One turn per entry: a step with these tool calls, then a final answer. */
function script(turns: Call[][]): MockTurn[] {
  return turns.flatMap((toolCalls, i) => [{ toolCalls }, `turn ${i} done`]);
}

function setup(turns: Call[][], files: Record<string, string>, options: WorkspaceCheckpointsOptions = {}) {
  const workspace = new MemoryWorkspace({ files });
  const checkpoints = new WorkspaceCheckpoints(workspace, options);
  const agent = createAgent({
    instructions: 'Edit files.',
    provider: mockModel(script(turns)),
    tools: createFsTools(workspace, { checkpoints }),
  });
  return { workspace, checkpoints, agent };
}

/** Three turns that create, edit and overwrite files. */
const THREE_TURNS: Call[][] = [
  [edit('a.txt', 'a0', 'a1'), write('c.txt', 'c0\n')],
  [write('b.txt', 'b1\n'), write('d.txt', 'd1\n'), edit('a.txt', 'a1', 'a2')],
  [edit('c.txt', 'c0', 'c2'), write('e/f.txt', 'f2\n'), write('b.txt', 'b2\n')],
];
const START = { 'a.txt': 'a0\n', 'b.txt': 'b0\n' };

async function runThreeTurns(options: WorkspaceCheckpointsOptions = {}) {
  const ctx = setup(THREE_TURNS, START, options);
  const session = ctx.agent.session();
  for (const input of ['one', 'two', 'three']) await session.send(input);
  return { ...ctx, sessionId: session.id };
}

describe('WorkspaceCheckpoints through createAgent().session()', () => {

  it("skips a file changed by something else as 'changed-since', unless force", async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns();
    await workspace.writeFile('b.txt', 'edited by the user\n');
    await workspace.rm('d.txt');
    const dry = await checkpoints.rewind(1, { sessionId, dryRun: true });
    expect(dry.skipped).toEqual([{ path: 'b.txt', reason: 'changed-since' }]);
    // d.txt was created by the agent and is already gone: nothing to do.
    expect(dry.deleted).toEqual(['e/f.txt']);

    const forced = await checkpoints.rewind(1, { sessionId, force: true });
    expect(forced.restored).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
  });

  it("does not back up files over maxFileBytes; rewind skips them as 'too-large' and never deletes them", async () => {
    const big = 'x'.repeat(50);
    const { workspace, checkpoints, agent } = setup([[write('big.txt', 'small\n'), write('new.txt', 'y'.repeat(60))]], { 'big.txt': big }, { maxFileBytes: 20 });
    const session = agent.session();
    await session.send('go');
    const result = await checkpoints.rewind(0, { sessionId: session.id });
    expect(result.skipped).toEqual([{ path: 'big.txt', reason: 'too-large' }]);
    expect(result.deleted).toEqual(['new.txt']);
    expect(workspace.snapshot()).toEqual({ 'big.txt': 'small\n' });
  });

  it("agent.send() without a session records every call as turn 0 of 'default'", async () => {
    const { workspace, checkpoints, agent } = setup([[write('a.txt', 'a1\n')], [write('b.txt', 'b1\n')]], { 'a.txt': 'a0\n' });
    await agent.send('one');
    await agent.send('two');
    expect(await checkpoints.list()).toEqual([{ turn: 0, paths: ['a.txt', 'b.txt'] }]);
    await checkpoints.rewind(0);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('keeps the newest maxTurns turns; an older turn cannot be rewound', async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns({ maxTurns: 2 });
    expect((await checkpoints.list({ sessionId })).map((t) => t.turn)).toEqual([1, 2]);
    await expect(checkpoints.rewind(0, { sessionId })).rejects.toThrow(/turns before 1 .* are no longer kept/);
    await checkpoints.rewind(1, { sessionId });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
  });

  it('clear() forgets a session', async () => {
    const { checkpoints, sessionId } = await runThreeTurns();
    await checkpoints.clear({ sessionId });
    expect(await checkpoints.list({ sessionId })).toEqual([]);
  });
});

describe('WorkspaceCheckpoints details', () => {

  const ctx = (sessionId: string, users: number) => ({
    toolCallId: 'c',
    sessionId,
    messages: Array.from({ length: users }, () => ({ role: 'user' as const, content: 'x' })),
    getToken: (): Promise<never> => Promise.reject(new Error('checkpoints.test.ts has no token store')),
    requireAuth: (): never => {
      throw new Error('checkpoints.test.ts has no token store');
    },
  });

  it('refuses a stored path that escapes the workspace, before changing anything', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n' } });
    const store = new MemoryWorkspaceCheckpointStore();
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1));
    const [backup] = await store.list('s');
    await store.append({ ...backup, path: '../outside.txt' });
    await expect(checkpoints.rewind(0, { sessionId: 's' })).rejects.toThrow(WorkspaceError);
    await expect(checkpoints.rewind(0, { sessionId: 's', dryRun: true })).rejects.toThrow(/invalid path/);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n' });
  });

  /** A store whose next append fails once the backup is stored, like a process killed right after it. */
  class CrashingStore extends MemoryWorkspaceCheckpointStore {
    crashAfterAppend = false;
    async append(backup: Parameters<MemoryWorkspaceCheckpointStore['append']>[0]): Promise<void> {
      await super.append(backup);
      if (this.crashAfterAppend) {
        this.crashAfterAppend = false;
        throw new Error('killed');
      }
    }
  }

  /** A workspace whose next writeFile fails after writing, like a process killed before the result was recorded. */
  class CrashingWorkspace extends MemoryWorkspace {
    crashAfterWrite = false;
    async writeFile(path: string, content: string): Promise<void> {
      await super.writeFile(path, content);
      if (this.crashAfterWrite) {
        this.crashAfterWrite = false;
        throw new Error('killed');
      }
    }
  }

  function crashSetup(files: Record<string, string>) {
    const workspace = new CrashingWorkspace({ files });
    const store = new CrashingStore();
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const [, writeFile, editFile] = createFsTools(workspace, { checkpoints });
    return { workspace, store, checkpoints, writeFile, editFile };
  }

  it('stores the backup before writing: a crash between the two changes nothing and leaves nothing to undo', async () => {
    const { workspace, store, checkpoints, writeFile } = crashSetup({ 'a.txt': 'a0\n' });
    store.crashAfterAppend = true;
    await expect(writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1))).rejects.toThrow('killed');
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
    expect(await checkpoints.rewind(0, { sessionId: 's', dryRun: true })).toEqual({ dryRun: true, restored: [], deleted: [], skipped: [] });
    // The resumed run re-runs the call; rewind then restores the original.
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1));
    expect(await checkpoints.rewind(0, { sessionId: 's' })).toMatchObject({ restored: ['a.txt'] });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('an edit_file re-run after a crash succeeds as already applied, and rewind restores the original', async () => {
    const { workspace, checkpoints, editFile } = crashSetup({ 'a.txt': 'x = 0\n' });
    workspace.crashAfterWrite = true;
    const args = { path: 'a.txt', old_string: 'x = 0', new_string: 'x = 1' };
    await expect(editFile.tool.execute!(args, ctx('s', 1))).rejects.toThrow('killed');
    expect(await editFile.tool.execute!(args, ctx('s', 1))).toMatch(/already applied/);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'x = 1\n' });
    expect(await checkpoints.rewind(0, { sessionId: 's' })).toMatchObject({ restored: ['a.txt'], skipped: [] });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'x = 0\n' });
  });

  it('track() with a plain function stores the backup first, so a crash during the write keeps the original', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n' } });
    const store = new MemoryWorkspaceCheckpointStore();
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const writeThenDie = async (): Promise<string> => {
      await workspace.writeFile('a.txt', 'a1\n');
      throw new Error('killed');
    };
    await expect(checkpoints.track(ctx('s', 1), 'a.txt', writeThenDie)).rejects.toThrow('killed');
    expect((await store.list('s')).map((b) => b.before)).toEqual(['a0\n']);
    // The written content's hash was never recorded, so rewind needs force - but the original is there.
    expect((await checkpoints.rewind(0, { sessionId: 's', dryRun: true })).skipped).toEqual([{ path: 'a.txt', reason: 'changed-since' }]);
    expect(await checkpoints.rewind(0, { sessionId: 's', force: true })).toMatchObject({ restored: ['a.txt'] });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
    // A plain-function write that finishes adds a second record carrying the written content's hash.
    await checkpoints.track(ctx('s', 1), 'a.txt', async () => {
      await workspace.writeFile('a.txt', 'a2\n');
      return 'a2\n';
    });
    expect((await store.list('s')).map((b) => [b.before, b.omitted])).toEqual([
      ['a0\n', undefined],
      [null, 'same-turn'],
    ]);
    expect(await checkpoints.rewind(0, { sessionId: 's' })).toMatchObject({ restored: ['a.txt'] });
  });

  it('validates its options and arguments', async () => {
    const workspace = new MemoryWorkspace();
    expect(() => new WorkspaceCheckpoints(workspace, { maxFileBytes: 0 })).toThrow(/maxFileBytes/);
    expect(() => new WorkspaceCheckpoints(workspace, { maxTurns: 1.5 })).toThrow(/maxTurns/);
    expect(() => new WorkspaceCheckpoints(workspace, { maxTurns: Infinity })).not.toThrow();
    await expect(new WorkspaceCheckpoints(workspace).rewind(-1)).rejects.toThrow(/non-negative integer/);
  });

  it('reports a failed restore with what was already rewound, and keeps the backups', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n', 'b.txt': 'b0\n' } });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1));
    await writeFile.tool.execute!({ path: 'b.txt', content: 'b1\n' }, ctx('s', 1));
    const original = workspace.writeFile.bind(workspace);
    workspace.writeFile = async (path, content) => (path === 'b.txt' ? Promise.reject(new Error('disk full')) : original(path, content));
    await expect(checkpoints.rewind(0, { sessionId: 's' })).rejects.toThrow(/rewind stopped at b\.txt: disk full Already rewound: a\.txt/);
    expect(await checkpoints.list({ sessionId: 's' })).toEqual([{ turn: 0, paths: ['a.txt', 'b.txt'] }]);
  });
});
