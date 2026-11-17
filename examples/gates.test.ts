import { describe, expect, it } from 'vitest';
import { isReadOnlyQuery } from './data-analyst/index';
import { runCheck } from './phase-pipeline/index';

describe('example gates', () => {
  it('data-analyst allows REPLACE() but refuses REPLACE INTO', () => {
    expect(isReadOnlyQuery("SELECT strftime('%Y-%m', REPLACE(created_at, '/', '-')) FROM orders")).toBe(true);
    expect(isReadOnlyQuery('REPLACE INTO orders VALUES (1)')).toBe(false);
    expect(isReadOnlyQuery('WITH x AS (SELECT 1) REPLACE INTO orders SELECT * FROM x')).toBe(false);
  });

  it('phase-pipeline gate fails broken code and passes valid code', async () => {
    const check = (implementation: string) => runCheck.execute({ implementation }, {} as never);
    await expect(check('export function greet(name) { return `hi ${name}`')).resolves.toMatch(/^FAIL: SyntaxError/);
    await expect(check('```ts\nexport function greet(name) { return `hi ${name}` }\n```')).resolves.toMatch(/^PASS/);
    await expect(check('const x = 1;')).resolves.toMatch(/^FAIL: no function/);
  });
});
