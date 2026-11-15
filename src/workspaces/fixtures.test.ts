
import { describe, expect, it } from 'vitest';
import type { Check } from '../evals/checks';
import { flowSpecSchema } from '../spec/v2/flow';
import { attachmentsSchema } from './contracts/agentRefs';
import { baseHarnessLayer, baseHarnessSchema, type HarnessLayer, type WorkspaceTree } from './contracts/baseHarness';
import { composeHarness, type EffectiveHarness } from './contracts/compose';
import { hasExecutableCriterion, harnessProfileSchema, harnessSchema, type Harness } from './contracts/harness';
import { crossCheckMainHarness, mainHarnessSchema } from './contracts/mainHarness';
import { pageSchema, type PageManifest } from './contracts/page';
import { workspacePolicySchema } from './contracts/policy';
import { pageUiSchema, validateUiBindings } from './contracts/ui';
import { workspaceManifestSchema, type WorkspaceManifest } from './contracts/workspace';
import { readFixtureTree, readNegativeIndex, readNegativeTree, type NegativeCase } from './__fixtures__/readTree';

interface Parser {
  safeParse(value: unknown): { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } };
}

const ROUTES: [RegExp, Parser][] = [
  [/^workspace\.json$/, workspaceManifestSchema],
  [/^harness\/harness\.json$/, baseHarnessSchema],
  [/^harness-profiles\/.+\/harness\.json$/, harnessProfileSchema],
  [/^pages\/[^/]+\/harness\/harness\.json$/, harnessSchema],
  [/^pages\/[^/]+\/page\.json$/, pageSchema],
  [/^pages\/[^/]+\/agents\.json$/, attachmentsSchema],
  [/^pages\/[^/]+\/ui\/page\.ui\.json$/, pageUiSchema],
  [/^main-agent\/harness\/main-harness\.json$/, mainHarnessSchema],
  [/^shared\/policies\/policy\.json$/, workspacePolicySchema],
  [/^workflows\/[^/]+\/workflow\.json$/, flowSpecSchema],
  [/^pages\/[^/]+\/workflow\.json$/, flowSpecSchema],
];

const POSITIVE = ['marketing', 'ops-desk', 'coding'];

const parserFor = (path: string): Parser | undefined => ROUTES.find(([pattern]) => pattern.test(path))?.[1];

interface FileProblem {
  file: string;
  message: string;
}

function parseProblems(path: string, value: unknown): FileProblem[] {
  const result = parserFor(path)?.safeParse(value);
  if (result === undefined || result.success) return [];
  return (result.error?.issues ?? []).map((issue) => ({ file: path, message: `${issue.path.join('.')}: ${issue.message}` }));
}

const fileProblems = (tree: WorkspaceTree): FileProblem[] => Object.entries(tree).flatMap(([path, value]) => parseProblems(path, value));

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const manifestOf = (tree: WorkspaceTree): WorkspaceManifest => workspaceManifestSchema.parse(tree['workspace.json']);

const pageOf = (tree: WorkspaceTree, id: string): PageManifest => pageSchema.parse(tree[`pages/${id}/page.json`]);

const textsFor = (tree: WorkspaceTree, dir: string, harness: Harness): Record<string, string> =>
  Object.fromEntries((harness.instructions ?? []).map((file) => [file, String(tree[`${dir}/${file}`] ?? '')]));

function profileLayers(tree: WorkspaceTree, refs: readonly string[], seen: Set<string>): HarnessLayer[] {
  return refs.flatMap((ref) => {
    if (seen.has(ref)) return [];
    seen.add(ref);
    const path = ref.replace(/^workspace:/, '');
    const dir = `harness-profiles/${path}`;
    const harness = harnessProfileSchema.parse(tree[`${dir}/harness.json`]);
    return [{ source: ref, harness, texts: textsFor(tree, dir, harness) }, ...profileLayers(tree, harness.extends ?? [], seen)];
  });
}

function pageLayers(tree: WorkspaceTree, id: string): HarnessLayer[] {
  const page = pageOf(tree, id);
  const dir = `pages/${id}`;
  const harness = harnessSchema.parse({ ...asRecord(tree[`${dir}/harness/harness.json`]), extends: page.harness.extends });
  const base = baseHarnessLayer(tree);
  const own: HarnessLayer = { source: 'page', harness, texts: textsFor(tree, dir, harness) };
  return [...(base ? [base] : []), ...profileLayers(tree, page.harness.extends, new Set()), own];
}

const composePage = (tree: WorkspaceTree, id: string): EffectiveHarness => composeHarness(pageLayers(tree, id));

const pageIds = (tree: WorkspaceTree): string[] => manifestOf(tree).pages;

function aliasesOf(tree: WorkspaceTree, id: string): string[] {
  return attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((agent) => agent.as);
}

function executionAliases(page: PageManifest): string[] {
  const { single, multiAgent, goal } = page.execution;
  return [single?.agent, multiAgent?.lead, ...(multiAgent?.delegates ?? []), goal?.lead, ...(goal?.delegates ?? [])].filter((alias): alias is string => alias !== undefined);
}

function agentFolderExists(tree: WorkspaceTree, id: string, ref: string): boolean {
  const [kind, name] = ref.split(':');
  if (kind === 'workspace') return `agents/${name}/agent.json` in tree;
  if (kind === 'local') return `pages/${id}/agents/${name}/agent.json` in tree;
  return kind === 'global';
}

function missingFiles(tree: WorkspaceTree, id: string): string[] {
  const page = pageOf(tree, id);
  const own = harnessSchema.parse(tree[`pages/${id}/harness/harness.json`]);
  const base = baseHarnessSchema.parse(tree['harness/harness.json'] ?? { schema: 'lousho.harness/1' });
  const wanted = [
    ...(own.instructions ?? []).map((file) => `pages/${id}/${file}`),
    ...(own.evaluation?.criteria ?? []).flatMap((criterion) => (criterion.check ? [`pages/${id}/${criterion.check}`] : [])),
    ...(own.context?.resources ?? []).map((file) => `pages/${id}/${file}`),
    ...(base.evaluation?.criteria ?? []).flatMap((criterion) => (criterion.check ? [`harness/${criterion.check}`] : [])),
    ...(page.execution.goal ? [`pages/${id}/goal.json`] : []),
    ...(page.execution.workflow?.workflow === './workflow.json' ? [`pages/${id}/workflow.json`] : []),
    ...(page.execution.workflow?.workflow.startsWith('workspace:') ? [`workflows/${page.execution.workflow.workflow.slice('workspace:'.length)}/workflow.json`] : []),
  ];
  return wanted.filter((path) => !(path in tree));
}

function integrityProblems(tree: WorkspaceTree): string[] {
  const manifest = manifestOf(tree);
  const folders = [...new Set(Object.keys(tree).flatMap((path) => /^pages\/([^/]+)\//.exec(path)?.[1] ?? []))];
  const problems = folders.filter((folder) => !manifest.pages.includes(folder)).map((folder) => `page folder ${folder} is not listed`);
  for (const id of manifest.pages) {
    const page = pageOf(tree, id);
    const aliases = aliasesOf(tree, id);
    problems.push(...executionAliases(page).filter((alias) => !aliases.includes(alias)).map((alias) => `${id}: alias ${alias} is not in agents.json`));
    const refs = attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((agent) => agent.ref);
    problems.push(...refs.filter((ref) => !agentFolderExists(tree, id, ref)).map((ref) => `${id}: ${ref} has no folder`));
    problems.push(...missingFiles(tree, id).map((path) => `${id}: ${path} is missing`));
  }
  const routes = tree['main-agent/harness/main-harness.json'] ? mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']).routes ?? [] : [];
  problems.push(...routes.filter((route) => !manifest.pages.includes(route.page)).map((route) => `route to missing page ${route.page}`));
  return problems;
}

describe('positive fixtures', () => {

  for (const name of POSITIVE) {
    const tree = readFixtureTree(name);

    it(`every ${name} page composes its harness layers and its UI binds to the composed harness`, () => {
      for (const id of pageIds(tree)) {
        const effective = composePage(tree, id);
        const ui = pageUiSchema.parse(tree[`pages/${id}/ui/page.ui.json`]);
        expect(validateUiBindings(ui, effective), id).toEqual([]);
        expect(hasExecutableCriterion({ schema: 'lousho.harness/1', evaluation: effective.evaluation }), `${id} has an executable criterion (R19)`).toBe(true);
      }
    });

    it(`${name} is internally consistent: pages listed, aliases, refs, routes and referenced files exist`, () => {
      expect(integrityProblems(tree)).toEqual([]);
    });
  }
});

describe('R19 check modules', () => {
  const fixtures = [...POSITIVE.map((name) => name), 'negative/_base'];

  it.each(fixtures)('every check in %s fails on {} and passes on a valid output', async (name) => {
    const tree = readFixtureTree(name);
    const checks = Object.keys(tree).filter((path) => /\/checks\/[^/]+\.ts$/.test(path));
    expect(checks.length).toBeGreaterThan(0);
    for (const path of checks) {
      const module = (await import(`./__fixtures__/${name}/${path}`)) as { default: Check<Record<string, unknown>> };
      const page = /^pages\/([^/]+)\//.exec(path)?.[1];
      const outputs = page ? harnessSchema.parse(tree[`pages/${page}/harness/harness.json`]).outputs?.schema : undefined;
      const field = (outputs as { required?: string[] } | undefined)?.required?.[0] ?? 'text';
      expect(module.default.evaluate({}).passed, path).toBe(false);
      expect(module.default.evaluate({ [field]: '   ' }).passed, path).toBe(false);
      expect(module.default.evaluate({ [field]: 'a valid output' }).passed, path).toBe(true);
    }
  });
});

describe('negative fixtures', () => {
  const index = readNegativeIndex();
  const treeOf = (item: NegativeCase): WorkspaceTree => readNegativeTree(item.name);
  const only = (kind: NegativeCase['checkedBy']): NegativeCase[] => index.cases.filter((item) => item.checkedBy === kind);

  const HELPER_ERRORS: Record<string, (tree: WorkspaceTree) => string[]> = {
    'main-harness-no-main-agent': (tree) => crossCheckMainHarness(mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']), manifestOf(tree)).errors,
    'ui-bind-missing-input': (tree) => validateUiBindings(pageUiSchema.parse(tree['pages/main/ui/page.ui.json']), composePage(tree, 'main')).map((problem) => `${problem.code} ${problem.message}`),
    'profile-cycle': (tree) => {
      try {
        composePage(tree, 'main');
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    },
    'rubric-only-improvable': (tree) => {
      const improvable = manifestOf(tree).improve?.enabled !== false && pageOf(tree, 'main').improve?.enabled !== false;
      const executable = hasExecutableCriterion(harnessSchema.parse(tree['pages/main/harness/harness.json']));
      return improvable && !executable ? ['PRD017 an improvable page needs an executable criterion'] : [];
    },
  };

  for (const item of only('schema')) {
    it(`${item.name} fails its schema in ${item.file} with the named error`, () => {
      const problems = fileProblems(treeOf(item));
      expect(new Set(problems.map((problem) => problem.file))).toEqual(new Set([item.file]));
      expect(problems.map((problem) => problem.message).join('\n')).toContain(item.expect);
    });
  }

  for (const item of only('helper')) {
    it(`${item.name} passes every per-file schema and fails the helper check with the named error`, () => {
      const tree = treeOf(item);
      expect(fileProblems(tree)).toEqual([]);
      expect(HELPER_ERRORS[item.name](tree).join('\n')).toContain(item.expect);
    });
  }

  for (const item of only('validateWorkspace')) {
    it(`${item.name} passes every per-file schema and is left to validateWorkspace (P0.10)`, () => {
      expect(fileProblems(treeOf(item))).toEqual([]);
    });
  }
});
