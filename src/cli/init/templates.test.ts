import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES, TEMPLATES, type Template } from './options';
import { renderProject, type ProjectConfig } from './templates';

const SDK = { version: '1.0.0-alpha.8', peerDependencies: { ai: '^4.3.19', zod: '^3.25.76' } };

function config(provider: string, template: Template): ProjectConfig {
  return {
    name: 'demo-agent',
    provider,
    template,
    packageManager: 'npm',
    sdkDependency: '^1.0.0-alpha.8',
    sdk: SDK,
  };
}

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
  pi: 'OPENROUTER_API_KEY',
};

/** The `ai` / provider-package pairing each provider is scaffolded with. */
const SCAFFOLD_PAIRINGS: Record<string, Record<string, string>> = {
  openai: { ai: '^7.0.0', '@ai-sdk/openai': '^4.0.0' },
  anthropic: { ai: '^7.0.0', '@ai-sdk/anthropic': '^4.0.0' },
  openrouter: { ai: '^7.0.0', '@ai-sdk/openai': '^4.0.0' },
  google: { ai: '^7.0.0', '@ai-sdk/google': '^4.0.0' },
  ollama: { ai: '^7.0.0', 'ollama-ai-provider-v2': '^4.0.0' },
  pi: { ai: '^7.0.0', '@earendil-works/pi-ai': '^1.0.3' },
};

const combos = PROVIDER_NAMES.flatMap((provider) => TEMPLATES.map((template) => [provider, template] as const));

describe('renderProject', () => {
  it.each(combos)('%s / %s: file set and key contents', (provider, template) => {
    const files = renderProject(config(provider, template));

    const expected = ['.env.example', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'src/agent.test.ts', 'tsconfig.json'];
    if (template === 'yaml') {
      expected.push('agent.yaml');
    } else if (template === 'telegram') {
      expected.push(
        'src/agent.ts',
        'src/index.ts',
        'src/approvals.ts',
        'src/telegram/api.ts',
        'src/telegram/md.ts',
        'src/telegram/bridge.ts',
        'src/telegram/md.test.ts',
        '.env',
      );
    } else {
      expected.push('src/agent.ts', 'src/index.ts');
    }
    expect(Object.keys(files).sort()).toEqual(expected.sort());

    expect(files['.env.example']).toMatch(new RegExp(`^${ENV_KEYS[provider]}=$`, 'm'));
    expect(files['.gitignore']).toMatch(/^\.env$/m);
    expect(files['.gitignore']).toMatch(/^!\.env\.example$/m);
    // Local trace files (fileTraceExporter) and other .lousho/ state stay out of git.
    expect(files['.gitignore']).toMatch(/^\.lousho\/$/m);

    const pkg = JSON.parse(files['package.json']!);
    expect(pkg).toMatchObject({ name: 'demo-agent', type: 'module', private: true });
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['dev', 'test', 'doctor']));
    expect(pkg.scripts.doctor).toMatch(/^lousho doctor/);
    expect(pkg.dependencies['lousho']).toBe('^1.0.0-alpha.8');
    expect(pkg.dependencies).toMatchObject({ ai: SCAFFOLD_PAIRINGS[provider]!.ai, zod: provider === 'ollama' ? '^4.0.0' : '^3.25.76' });

    expect(JSON.parse(files['tsconfig.json']!).compilerOptions).toMatchObject({ strict: true, module: 'NodeNext' });
    expect(files['README.md']).toContain(ENV_KEYS[provider]);
    expect(files['README.md']).toContain('npm run dev');

    // Docs links point at the docs site, never at GitHub's raw markdown for main.
    expect(files['README.md']).toContain('Docs: https://lousho.com/quickstart');
    for (const [file, content] of Object.entries(files)) expect(content, file).not.toContain('blob/main/docs');
  });

  it.each(PROVIDER_NAMES)('%s: zod pairs with the scaffolded ai major', (provider) => {
    const sdk = { ...SDK, peerDependencies: { ...SDK.peerDependencies, zod: '^3.25.76 || ^4.0.0' } };
    const pkg = JSON.parse(renderProject({ ...config(provider, 'minimal'), sdk })['package.json']!);
    const zod3Only = SCAFFOLD_PAIRINGS[provider]!.ai === '^4.3.19';
    // zod 3 for ai 4, zod 4 for Ollama's ai 6/7 package, both for the rest.
    expect(pkg.dependencies.zod).toBe(zod3Only ? '^3.25.76' : provider === 'ollama' ? '^4.0.0' : '^3.25.76 || ^4.0.0');
  });

  it.each(combos.filter(([, template]) => template !== 'yaml'))(
    '%s / %s: agent.ts uses createAgent + defineTool and the test uses mockModel',
    (provider, template) => {
      const files = renderProject(config(provider, template));
      expect(files['src/agent.ts']).toContain(
        "import { createAgent, defineTool, type CreateAgentConfig, type LLMProvider } from 'lousho';"
      );
      // The default export is what `lousho dev|chat|mcp|acp|build src/agent.ts` load.
      expect(files['src/agent.ts']).toContain('export default config;');
      const pkg = JSON.parse(files['package.json']!);
      expect(pkg.scripts['dev:ui']).toBe('lousho dev src/agent.ts');
      expect(pkg.scripts.build).toBe('lousho build src/agent.ts --target=node-server');
      expect(files['src/agent.ts']).toMatch(new RegExp(`model: '${provider}/[^']+'`));
      expect(files['src/agent.ts']).toContain('instructions');
      expect(files['src/agent.test.ts']).toContain("import { mockModel } from 'lousho/testing';");
      expect(files['agent.yaml']).toBeUndefined();
      expect(JSON.parse(files['package.json']!).scripts.dev).toContain('src/index.ts');
    }
  );

  it.each(combos)('%s / %s: AGENTS.md is short, lists the real scripts and only lousho.com links', (provider, template) => {
    const files = renderProject(config(provider, template));
    const agents = files['AGENTS.md']!;
    expect(agents.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
    const scripts = JSON.parse(files['package.json']!).scripts as Record<string, string>;
    const listed = [...agents.matchAll(/^- `npm run ([\w:-]+)`/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual(Object.keys(scripts).sort());
    expect(agents).toContain(ENV_KEYS[provider]);
    expect(agents).toContain(template === 'yaml' ? 'agent.yaml' : 'defineTool');
    if (template !== 'yaml') {
      for (const word of ['needsApproval', 'mockModel', 'maxTokens', `${provider}/`]) expect(agents).toContain(word);
    }
    const urls = [...agents.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
    expect(urls).toContain('https://lousho.com/llms.txt');
    for (const url of urls) expect(url).toMatch(/^https:\/\/lousho\.com\//);
    expect(files['CLAUDE.md']).toBe('@AGENTS.md\n');
  });

  it.each(Object.entries(SCAFFOLD_PAIRINGS))('%s gets one consistent ai / provider package pairing', (provider, pairing) => {
    const dependencies = JSON.parse(renderProject(config(provider, 'minimal'))['package.json']!).dependencies;
    expect(dependencies).toMatchObject(pairing);
  });

  it.each(TEMPLATES)('the %s template can build (tsup) and test under yarn 1, which skips peers (vite)', (template) => {
    const pkg = JSON.parse(renderProject(config('openai', template))['package.json']!);
    expect(pkg.devDependencies).toMatchObject({ tsup: expect.any(String), vite: expect.any(String) });
    expect(pkg.scripts.build).toMatch(/^lousho build \S+ --target=node-server$/);
  });

  it.each(combos.filter(([, template]) => template !== 'yaml'))(
    'caps output tokens so a low-credit key does not fail its first run: %s / %s',
    (provider, template) => {
      const files = renderProject(config(provider, template));
      expect(files['src/agent.ts']).toMatch(/const modelSettings = \{ maxTokens: 4096 \};[\s\S]*tools, modelSettings \}/);
      expect(files['README.md']).toContain('requires more credits');
    }
  );

  it.each(TEMPLATES)('snapshot: %s package.json', (template) => {
    expect(renderProject(config('openai', template))['package.json']).toMatchSnapshot();
  });

  it.each(combos.filter(([, template]) => template !== 'yaml'))('snapshot: %s / %s agent.ts', (provider, template) => {
    expect(renderProject(config(provider, template))['src/agent.ts']).toMatchSnapshot();
  });
});
