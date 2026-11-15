import { describe, expect, it } from 'vitest';
import { readFixtureTree, readNegativeIndex, readNegativeTree } from '../__fixtures__/readTree';
import type { WorkspaceTree } from './baseHarness';
import { validateWorkspace, type WorkspaceProblem } from './validate';

const errors = (problems: WorkspaceProblem[]): WorkspaceProblem[] => problems.filter((problem) => problem.severity === 'error');
const codes = (problems: WorkspaceProblem[]): string[] => [...new Set(problems.map((problem) => problem.code))];

function withFile(tree: WorkspaceTree, path: string, value: unknown): WorkspaceTree {
  return { ...tree, [path]: value };
}

function withoutFiles(tree: WorkspaceTree, prefix: string): WorkspaceTree {
  return Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith(prefix)));
}

function edit(tree: WorkspaceTree, path: string, change: (doc: Record<string, unknown>) => Record<string, unknown>): WorkspaceTree {
  return withFile(tree, path, change(structuredClone(tree[path]) as Record<string, unknown>));
}

const base = (): WorkspaceTree => readNegativeTree(readNegativeIndex().base);

describe('validateWorkspace', () => {

  it('each negative fixture yields exactly its code', () => {
    const index = readNegativeIndex();
    expect(new Set(index.cases.map((item) => item.code)).size).toBe(22);
    for (const item of index.cases) {
      const problems = validateWorkspace(readNegativeTree(item.name), { mode: 'default' });
      expect(codes(problems), item.name).toEqual([item.code]);
      expect(errors(problems).map((problem) => problem.file), item.name).toContain(item.file);
    }
  });

  it('a rubric-only improvable page yields PRD017; with improve disabled it is a warning', () => {
    const tree = readNegativeTree('rubric-only-improvable');
    const improvable = validateWorkspace(tree);
    expect(improvable).toEqual([expect.objectContaining({ severity: 'error', code: 'PRD017', file: 'pages/main/harness/harness.json', path: 'evaluation.criteria' })]);
    expect(improvable[0].message).toContain('R19');
    const pageOff = edit(tree, 'pages/main/page.json', (doc) => ({ ...doc, improve: { enabled: false } }));
    expect(validateWorkspace(pageOff)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD017' })]);
    const workspaceOff = edit(tree, 'workspace.json', (doc) => ({ ...doc, improve: { enabled: false } }));
    expect(validateWorkspace(workspaceOff)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD017' })]);
    const pageOn = edit(workspaceOff, 'pages/main/page.json', (doc) => ({ ...doc, improve: { enabled: true } }));
    expect(validateWorkspace(pageOn)).toEqual([expect.objectContaining({ severity: 'error', code: 'PRD017' })]);
  });

  it('never throws: garbage input becomes problems', () => {
    expect(codes(validateWorkspace({}))).toEqual(['PRD023']);
    expect(codes(validateWorkspace({ 'workspace.json': '{not json' }))).toEqual(['PRD028']);
    expect(codes(validateWorkspace({ 'workspace.json': [] }))).toEqual(['PRD023']);
    const tree = withFile(withFile(base(), 'pages/main/page.json', 'oops'), 'pages/main/agents.json', 42);
    expect(() => validateWorkspace(tree)).not.toThrow();
    expect(errors(validateWorkspace(tree)).length).toBeGreaterThan(0);
  });
});

describe('policy lives only in shared/policies (R13, G6)', () => {
  it('a policy file with an invalid field names R13 and G6', () => {
    const tree = edit(base(), 'shared/policies/policy.json', (doc) => ({ ...doc, network: { allowHosts: ['HTTP://x'] } }));
    const problems = validateWorkspace(tree);
    expect(codes(problems)).toEqual(['PRD026']);
    expect(problems[0]).toMatchObject({ file: 'shared/policies/policy.json', path: 'network.allowHosts.0' });
    expect(problems[0].message).toMatch(/R13.*G6/);
  });

  it('workspace folder fields may not point into shared/policies, pages or each other', () => {
    for (const [field, value] of [['agents', './shared/policies'], ['workflows', 'pages/flows'], ['harnessProfiles', './harness/profiles']] as const) {
      const tree = edit(base(), 'workspace.json', (doc) => ({ ...doc, [field]: value }));
      const problems = validateWorkspace(tree);
      expect(problems, field).toContainEqual(expect.objectContaining({ code: 'PRD027', file: 'workspace.json', path: field }));
      expect(codes(problems), field).toEqual(['PRD027']);
    }
    const twin = edit(base(), 'workspace.json', (doc) => ({ ...doc, agents: 'stuff', workflows: './stuff/' }));
    expect(validateWorkspace(twin)).toEqual([expect.objectContaining({ code: 'PRD027', path: 'workflows' })]);
  });

  it('folder fields are normalised before the overlap checks and lookups', () => {
    for (const value of ['a/../shared/policies', 'shared/./policies', 'shared//policies', 'x/../pages']) {
      const tree = edit(base(), 'workspace.json', (doc) => ({ ...doc, workflows: value }));
      expect(codes(validateWorkspace(tree)), value).toEqual(['PRD027']);
    }
    const agents = edit(base(), 'workspace.json', (doc) => ({ ...doc, agents: 'x/../agents' }));
    expect(validateWorkspace(agents)).toEqual([]);
  });

  it('a referenced harness schema file is scanned like an inline schema', () => {
    const inline = (base()['pages/main/harness/harness.json'] as { inputs: { schema: Record<string, unknown> } }).inputs.schema;
    const referencing = edit(base(), 'pages/main/harness/harness.json', (doc) => ({ ...doc, inputs: { schema: 'schemas/in.json' } }));
    for (const extra of [{ permissions: [], tools: ['bash'], secrets: [] }, { 'x-lousho': { tools: ['bash'] } }]) {
      const problems = validateWorkspace(withFile(referencing, 'pages/main/schemas/in.json', { ...inline, ...extra }));
      expect(codes(problems), JSON.stringify(extra)).toEqual(['PRD001']);
      expect(problems.every((problem) => problem.file === 'pages/main/schemas/in.json')).toBe(true);
      const inlined = edit(base(), 'pages/main/harness/harness.json', (doc) => ({ ...doc, inputs: { schema: { ...inline, ...extra } } }));
      expect(codes(validateWorkspace(inlined)), JSON.stringify(extra)).toEqual(['PRD001']);
    }
    const named = { ...inline, properties: { ...(inline.properties as object), tools: { type: 'string' } } };
    expect(validateWorkspace(withFile(referencing, 'pages/main/schemas/in.json', named))).toEqual([]);
  });
});

describe('cross-file checks', () => {

  it('a main harness above the workspace concurrency limit is a warning', () => {
    const marketing = readFixtureTree('marketing');
    const tree = edit(marketing, 'main-agent/harness/main-harness.json', (doc) => ({ ...doc, limits: { maxConcurrentPages: 9 } }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD031' })]);
  });

  it('every extends profile exists, or is a global ref resolveGlobal answers', () => {
    const tree = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['global:tones/calm@^1.0.0'] } }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD024', file: 'pages/main/page.json', path: 'harness.extends.0' })]);
    const profile = { 'harness.json': { schema: 'lousho.harness/1', id: 'calm', version: '1.0.0', instructions: ['calm.md'] }, 'calm.md': 'Stay calm.' };
    const resolveGlobal = (ref: string): WorkspaceTree | undefined => (ref === 'global:tones/calm@^1.0.0' ? profile : undefined);
    expect(validateWorkspace(tree, { mode: 'default', resolveGlobal })).toEqual([]);
    const missing = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['workspace:ghost', 'nope'] } }));
    expect(validateWorkspace(missing).map((problem) => problem.code)).toEqual(['PRD024', 'PRD024']);
  });

  it('a global profile that fails its schema is reported against its ref', () => {
    const tree = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['global:tones/calm@^1.0.0'] } }));
    const resolveGlobal = (): WorkspaceTree => ({ 'harness.json': { schema: 'lousho.harness/1', version: '1.0.0' } });
    expect(validateWorkspace(tree, { resolveGlobal })).toEqual([expect.objectContaining({ code: 'PRD003', file: 'global:tones/calm@^1.0.0' })]);
  });

  it('files a harness lists must exist', () => {
    const tree = withoutFiles(base(), 'pages/main/harness/');
    const withHarness = withFile(tree, 'pages/main/harness/harness.json', base()['pages/main/harness/harness.json']);
    expect(codes(validateWorkspace(withHarness))).toEqual(['PRD032']);
    expect(validateWorkspace(withHarness).map((problem) => problem.file)).toEqual(['pages/main/harness/task.md', 'pages/main/harness/checks/report-present.ts']);
  });

  it('capabilities.require is a warning until P1 defines the effective toolset', () => {
    const requiring = edit(base(), 'pages/main/harness/harness.json', (doc) => ({ ...doc, capabilities: { require: ['image.generate'] } }));
    const problems = validateWorkspace(requiring);
    expect(problems).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD025', path: 'capabilities.require.0' })]);
    expect(problems[0].message).toContain('P1');
    const declared = edit(requiring, 'agents/helper/agent.json', (doc) => ({ ...doc, capabilities: ['image.generate'] }));
    expect(validateWorkspace(declared)).toEqual(problems);
  });

  it('a resolveGlobal that throws becomes PRD024', () => {
    const tree = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['global:tones/calm@^1.0.0'] } }));
    const resolveGlobal = (): WorkspaceTree => {
      throw new TypeError('host offline');
    };
    const problems = validateWorkspace(tree, { resolveGlobal });
    expect(problems).toEqual([expect.objectContaining({ code: 'PRD024', file: 'pages/main/page.json', path: 'harness.extends.0' })]);
    expect(problems[0].message).toContain('resolveGlobal failed: host offline');
  });

  it('a missing harness schema file is PRD032, not a skipped UI check', () => {
    const tree = edit(readNegativeTree('ui-bind-missing-input'), 'pages/main/harness/harness.json', (doc) => ({ ...doc, inputs: { schema: 'schemas/input.json' } }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD032', file: 'pages/main/schemas/input.json' })]);
  });

  it('goal and workflow files a page names must exist and be well formed', () => {
    const goal = withoutFiles(readNegativeTree('goal-check-missing-criterion'), 'pages/main/goal.json');
    expect(validateWorkspace(goal)).toEqual([expect.objectContaining({ code: 'PRD030', file: 'pages/main/goal.json' })]);
    const flow = withFile(readNegativeTree('workflow-unknown-alias'), 'pages/main/workflow.json', { code: 'x', name: 'X', flow: { type: 'mystery', id: 'a' } });
    expect(codes(validateWorkspace(flow))).toEqual(['PRD030']);
    const shared = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, execution: { type: 'workflow', workflow: { workflow: 'workspace:ghost' } } }));
    expect(validateWorkspace(shared)).toEqual([expect.objectContaining({ code: 'PRD030', file: 'workflows/ghost/workflow.json' })]);
  });
});
