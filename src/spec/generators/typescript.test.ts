import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from '../v2/types';
import { specToCode } from './typescript';

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

/** A spec touching every section specToCode renders (S16b's full-section spec, inline). */
const full = spec({
  description: 'Does everything.',
  fallbackModels: ['mock/f1', 'mock/f2'],
  promptRef: 'support@prod',
  modelSettings: { maxTokens: 64, temperature: 0.2 },
  reasoning: 'low',
  tools: [{ builtin: 'current_date' }, { hosted: 'web_search' }],
  mcpServers: {
    docs: { url: 'https://x.test/mcp', headers: { Authorization: { env: 'HDR' }, 'X-Key': { secret: 'tok' } } },
  },
  skills: [{ inline: { name: 'changelog', description: 'Write changelogs.', content: '# C' } }],
  memory: [
    {
      name: 'notes',
      scope: 'session',
      provider: { type: 'in-memory' },
      itemJsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
      itemKey: 'text',
    },
  ],
  subagents: {
    helper: { inline: { name: 'helper', model: 'mock/m', instructions: 'Help.', description: 'Helps.' } },
  },
  subagentOptions: { maxConcurrent: 2 },
  maxSubagentDepth: 2,
  handoffs: [{ agent: 'helper', description: 'Go helper.' }],
  maxHandoffs: 4,
  guardrails: [{ id: 'g1', name: 'deny-topics', on: 'input', options: { topics: ['weapons'] } }],
  permissions: [{ id: 'p1', tool: '*', action: 'allow' }],
  permissionMode: 'plan',
  approvalTtlMs: 60_000,
  askQuestion: true,
  hooks: [{ id: 'h1', inline: { name: 'noop', point: 'postGenerate', code: 'return;' } }],
  output: { jsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  limits: { maxSteps: 7 },
  maxSteps: 9,
  compaction: { thresholdPercent: 0.5 },
  retry: { maxRetries: 4, backoff: { initialMs: 10 } },
  rateLimit: { requestsPerMinute: 12 },
  promptCaching: 'auto',
  toolSearch: { maxResults: 3 },
  codeMode: { timeoutMs: 1000 },
  triggers: [{ id: 't1', type: 'chat' }],
});
const fileInstructions = spec({ instructions: { file: 'prompts/main.md' } });

/** The import lines the generated module prints, in order. */
function importLines(code: string): string[] {
  return code.split('\n').filter((line) => line.startsWith('import '));
}

describe('specToCode', () => {

  it('renders a spec with every section', () => {
    expect(specToCode(full)).toMatchSnapshot();
  });

  it("imports readFile for { file } instructions and reads under host.baseDir", () => {
    const code = specToCode(fileInstructions);
    expect(importLines(code)[0]).toBe("import { readFile } from 'node:fs/promises';");
    expect(code).toContain("instructions: await readFile(path.join(host.baseDir, 'prompts/main.md'), 'utf8')");
  });

  it('renders a throwing resolveHandoffAgent when a handoff target is not defined in the file', () => {
    const code = specToCode(spec({ handoffs: [{ agent: 'ext' }] }));
    expect(code).toContain("throw new Error(`handoff target '${name}' is not defined in this file`)");
  });
});
