import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('parseAgentSpecV2', () => {
  it('returns a minimal valid spec', () => {
    expect(parseAgentSpecV2(base)).toEqual(base);
  });

  it('takes a GitHub App or a token for the github channel and integration, never neither', () => {
    const app = { appId: { env: 'APP_ID' }, privateKey: { env: 'APP_KEY' } };
    const spec = {
      ...base,
      tools: [{ integration: 'github', credentials: { owner: 'o', repo: 'r', ...app } }],
      triggers: [{ id: 'gh', type: 'channel', channel: 'github', pullRequests: true, secrets: { webhookSecret: { env: 'S' }, ...app } }],
    };
    expect(parseAgentSpecV2(spec).triggers?.[0]).toMatchObject({ pullRequests: true });
    expect(thrown({ ...base, triggers: [{ id: 'gh', type: 'channel', channel: 'github', secrets: { webhookSecret: { env: 'S' } } }] }).message).toMatch(/secrets\.token, or secrets\.appId/);
    expect(thrown({ ...base, tools: [{ integration: 'github', credentials: { owner: 'o', repo: 'r', appId: { env: 'A' } } }] }).message).toMatch(/credentials\.token, or credentials\.appId/);
  });

  it('takes github without owner and repo as account-wide with a token, and owner and repo only together', () => {
    const token = { secret: 'GITHUB_TOKEN' };
    expect(parseAgentSpecV2({ ...base, tools: [{ integration: 'github', credentials: { token } }] }).tools).toHaveLength(1);
    expect(thrown({ ...base, tools: [{ integration: 'github', credentials: { owner: 'o', token } }] }).message).toMatch(/owner and credentials\.repo together/);
    expect(thrown({ ...base, tools: [{ integration: 'github', credentials: { appId: { env: 'A' }, privateKey: { env: 'K' } } }] }).message).toMatch(/account-wide tools, which need credentials\.token/);
  });

  it('accepts the Confluence, Google, Jenkins and Figma integrations and Slack with a bot token', () => {
    const secret = (name: string) => ({ secret: name });
    const tools = [
      { integration: 'confluence', credentials: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: secret('JIRA_API_TOKEN') } },
      { integration: 'google', credentials: { clientId: 'id', clientSecret: secret('GCS'), refreshToken: secret('GRT') } },
      { integration: 'jenkins', credentials: { baseUrl: 'https://ci', username: 'me', apiToken: secret('JT') } },
      { integration: 'figma', credentials: { token: secret('FIGMA_TOKEN') } },
      { integration: 'slack', credentials: { botToken: secret('SLACK_BOT_TOKEN') } },
    ];
    expect(parseAgentSpecV2({ ...base, tools }).tools).toHaveLength(5);
    expect(thrown({ ...base, tools: [{ integration: 'slack', credentials: {} }] }).message).toMatch(/webhookUrl, credentials\.botToken, or both/);
    expect(thrown({ ...base, tools: [{ integration: 'figma', credentials: { token: 'figd_literal' } }] }).message).toMatch(/credentials\.token is a secret/);
  });

  it('accepts instructions as a file reference', () => {
    const spec = { ...base, instructions: { file: 'prompts/main.md' } };
    expect(parseAgentSpecV2(spec)).toEqual(spec);
  });

  it('rejects an instructions.file that escapes the spec folder', () => {
    const error = thrown({ ...base, instructions: { file: '../x.md' } });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    // zod 3 surfaces the union member's issue ('instructions.file'); zod 4 reports the union itself ('instructions').
    expect(Object.keys(error.errors ?? {}).some((key) => key === 'instructions' || key.startsWith('instructions.'))).toBe(true);
  });

  it('rejects a missing version, naming it', () => {
    const { version: _version, ...noVersion } = base;
    const error = thrown(noVersion);
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain("'version'");
  });

  it('rejects version: 1, telling how to convert', () => {
    const error = thrown({ ...base, version: 1 });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain('must be 2');
  });

  it('suggests the field an unknown key is a typo of', () => {
    const error = thrown({ ...base, instructons: 'x' });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain("unknown field 'instructons' (did you mean 'instructions'?)");
  });

  it('reports an unknown key with no plausible match plainly', () => {
    const error = thrown({ ...base, zzzz: 1 });
    expect(error.message).toContain("unknown field 'zzzz'");
    expect(error.message).not.toContain('did you mean');
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED when only unsupported flow shapes are set', () => {
    const editorOnly = { code: 'f', name: 'F', flow: { type: 'step', id: 'x' } };
    const error = thrown({ ...base, flow: editorOnly });
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.message).toContain('uses fields this SDK cannot run yet');
    expect(error.message).toContain("'flow.flow'");
  });

  it('throws LOUSHO_SPEC_INVALID when unsupported and invalid problems mix', () => {
    const editorOnly = { code: 'f', name: 'F', flow: { type: 'step', id: 'x' } };
    const error = thrown({ ...base, flow: editorOnly, model: 'gpt-4o' });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('flow.flow');
    expect(error.errors).toHaveProperty('model');
  });

  it('reports a spec-level flow problem at its absolute path', () => {
    const flow = { code: 'f', name: 'F', flow: { type: 'sequence', id: 's', steps: [{ type: 'end' }] } };
    const error = thrown({ ...base, flow });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('flow.flow.steps.0.id');
  });

  it("rejects a model that is not 'provider/model'", () => {
    expect(thrown({ ...base, model: 'gpt-4o' }).message).toContain("must be 'provider/model'");
  });

  it('validates the agent name', () => {
    expect(parseAgentSpecV2({ ...base, name: 'Support bot 2' }).name).toBe('Support bot 2');
    for (const name of ['', 'a/b', '-x', 'x'.repeat(65)]) {
      expect(thrown({ ...base, name }).code).toBe('LOUSHO_SPEC_INVALID');
    }
  });

  it("accepts a promptRef 'name@label' and rejects a bare name", () => {
    expect(parseAgentSpecV2({ ...base, promptRef: 'support@prod' }).promptRef).toBe('support@prod');
    expect(thrown({ ...base, promptRef: 'support' }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('validates instructionsByFamily keys as lowercase model families', () => {
    expect(parseAgentSpecV2({ ...base, instructionsByFamily: { openai: 'x' } }).instructionsByFamily).toEqual({ openai: 'x' });
    expect(thrown({ ...base, instructionsByFamily: { 'Open AI': 'x' } }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('validates each fallbackModels entry at its index', () => {
    expect(parseAgentSpecV2({ ...base, fallbackModels: ['openai/gpt-4o-mini'] }).fallbackModels).toEqual(['openai/gpt-4o-mini']);
    const error = thrown({ ...base, fallbackModels: ['gpt-4o'] });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('fallbackModels.0');
  });

  it('rejects an empty description', () => {
    expect(thrown({ ...base, description: '' }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('rejects a non-object spec', () => {
    expect(thrown('nope').code).toBe('LOUSHO_SPEC_INVALID');
  });
});
