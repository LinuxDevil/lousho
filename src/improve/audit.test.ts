import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, readAudit, verifyAudit } from './audit';

let dir: string;
const log = (): string => path.join(dir, '.lousho', 'audit.jsonl');
const lines = (): string[] => readFileSync(log(), 'utf8').trimEnd().split('\n');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-audit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendAudit', () => {

  it('continues the chain after a truncated last line', async () => {
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'one' });
    appendFileSync(log(), '{"seq":2,"at":"20');
    const next = await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'three' });
    expect(next.seq).toBe(3);
    expect(lines()).toHaveLength(3);
    expect(verifyAudit(dir)).toBe(2);
  });
});

describe('verifyAudit', () => {

  it('a truncated last line is reported and does not throw', async () => {
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'one' });
    await appendAudit(dir, { actor: 'gate', action: 'apply', reason: 'two' });
    const text = readFileSync(log(), 'utf8');
    writeFileSync(log(), text.slice(0, text.length - 20));
    expect(() => verifyAudit(dir)).not.toThrow();
    expect(verifyAudit(dir)).toBe(2);
    expect(readAudit(dir).map((entry) => entry.seq)).toEqual([1]);
  });
});
