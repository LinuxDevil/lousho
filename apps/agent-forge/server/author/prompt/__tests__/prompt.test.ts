import { describe, expect, it } from 'vitest';
import { AUTHOR_PROMPT_SECTIONS, AUTHOR_STATIC_PROMPT, type AuthorPromptCatalogs } from '../index';
import { renderCatalogPreamble } from '../catalogPreamble';

/**
 * The Author's system prompt contract: byte-stable section assembly (the
 * committed snapshot is the tripwire for any prose edit), a deterministic
 * catalog preamble (sorted, order-independent, env-free), and a scan that
 * keeps every tool name the prose mentions inside AUTHOR_TOOL_NAMES.
 */
const CATALOGS: AuthorPromptCatalogs = {
  models: [
    {
      id: 'anthropic/claude-sonnet-5-5',
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
    },
    {
      id: 'openai/gpt-4o',
      capabilities: { tools: true, vision: true, reasoning: false, structuredOutput: true },
    },
  ],
  tools: [
    { name: 'web_fetch', description: 'Fetches a web page.', needsCredentials: [], mutating: false },
    { name: 'http_request', description: 'Makes an HTTP request.', needsCredentials: ['X_API_KEY'], mutating: true },
  ],
  guardrails: [
    { name: 'pii', description: 'Finds personal data.', on: ['input', 'output'] },
    { name: 'prompt-injection', description: 'Flags attempts to override instructions.', on: ['input'] },
  ],
  triggers: [
    { type: 'chat', description: 'Runs when the user sends a chat message.' },
    { type: 'cron', description: 'Runs on a schedule.' },
  ],
};

/** The section headings AUTHOR_STATIC_PROMPT must show, in order (PLAN 8.1's fixed assembly). */
const EXPECTED_HEADINGS = [
  '# lousho Agent Author',
  '## Working out what the user wants',
  '## Turn context from the app',
  '## Grounding every value',
  '## Building a new agent',
  '## Changing an existing agent',
  '## Patch contract',
  '## The spec you are assembling',
  '## Picking building blocks',
  "## Writing the agent's instructions",
  '## Collecting secrets',
  '## Trying a draft',
  '## Actions the user takes in the app',
  '## Capability honesty',
  '## Reply style',
  '## Rules you never break',
];

describe('AUTHOR_STATIC_PROMPT', () => {

  it('assembles the 16 sections in the contract order, joined by one blank line', () => {
    expect(AUTHOR_STATIC_PROMPT).toBe(AUTHOR_PROMPT_SECTIONS.join('\n\n'));
    const headings = AUTHOR_STATIC_PROMPT.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual(EXPECTED_HEADINGS);
  });
});

describe('renderCatalogPreamble', () => {

  it('renders (none) when a model reports no capabilities', () => {
    const prompt = renderCatalogPreamble({
      ...CATALOGS,
      models: [{ id: 'local/echo', capabilities: { tools: false, vision: false, reasoning: false, structuredOutput: false } }],
    });
    expect(prompt).toContain('- local/echo (none)');
  });
});
