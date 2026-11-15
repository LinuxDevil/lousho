import { describe, it, expect } from 'vitest';
import { issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function parse(key: string, value: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, [key]: value });
}

function accept(key: string, values: unknown[]): void {
  for (const value of values) {
    const result = parse(key, value);
    expect(result.success, `${key} ${JSON.stringify(value)}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
  }
}

/** Asserts every value fails; `path`/`message` (when given) are checked on the first issue. */
function reject(key: string, cases: ReadonlyArray<{ value: unknown; path?: string; message?: string | RegExp }>): void {
  for (const { value, path, message } of cases) {
    const result = parse(key, value);
    expect(result.success, `${key} ${JSON.stringify(value)} should fail`).toBe(false);
    if (result.success) continue;
    const first = result.error.issues[0];
    if (path !== undefined) expect(issuePath(first), `${key} ${JSON.stringify(value)} first issue path`).toBe(path);
    if (message !== undefined) {
      const text = first.message;
      if (typeof message === 'string') expect(text).toContain(message);
      else expect(text).toMatch(message);
    }
  }
}

describe('agentSpecV2Schema runtime keys', () => {
  it('modelSettings accepts SDK settings and rejects unknown keys with a did-you-mean', () => {
    accept('modelSettings', [{ temperature: 0.2, maxTokens: 1024, toolChoice: 'auto' }]);
    reject('modelSettings', [
      { value: { maxOutputTokens: 10 }, path: 'modelSettings.maxOutputTokens', message: "did you mean 'maxTokens'" },
      { value: { temperature: 3 }, path: 'modelSettings.temperature' },
    ]);
  });
});
