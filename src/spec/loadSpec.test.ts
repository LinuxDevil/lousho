import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec } from './loadSpec';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-spec-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('loadSpec', () => {

  it('suggests the spec field a top-level typo meant', () => {
    const typo = tmpFile(
      'typo.yaml',
      'name: a\nprompt: hi\nprovider:\n  type: mock\n  model: m\ntool:\n  - http\n'
    );
    expect(() => loadSpec(typo)).toThrow(
      expect.objectContaining({
        code: 'LOUSHO_SPEC_UNKNOWN_FIELD',
        message: expect.stringContaining("unknown field 'tool' (did you mean 'tools'?)"),
      })
    );

    const missing = tmpFile('promt.yaml', 'name: a\npromt: hi\nprovider:\n  type: mock\n  model: m\n');
    expect(() => loadSpec(missing)).toThrow(
      expect.objectContaining({
        code: 'LOUSHO_SPEC_INVALID',
        message: expect.stringMatching(/'prompt': .*; unknown field 'promt' \(did you mean 'prompt'\?\)/),
      })
    );

    const unrelated = tmpFile('extra.yaml', 'name: a\nprompt: hi\nprovider:\n  type: mock\n  model: m\ndescription: x\n');
    expect(loadSpec(unrelated).name).toBe('a');
  });

  it('throws for an unsupported extension', () => {
    const filePath = tmpFile('agent.txt', 'not a spec');
    expect(() => loadSpec(filePath)).toThrow(/unsupported extension/);
    expect(() => loadSpec(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_UNSUPPORTED_FORMAT' }));
  });
});

describe('loadSpec messages (CLI audit)', () => {
  const write = (name: string, text: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-spec-msg-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };

  it('names the file and the code for a JSON syntax error', () => {
    const file = write('broken.json', '{"name": "x" "prompt": "y"}');
    expect(() => loadSpec(file)).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID', message: expect.stringContaining(`'${file}' is not valid JSON:`) }));
  });

  it('points a top-level model at provider.model', () => {
    const file = write('model.yaml', 'name: x\nprompt: y\nmodel: openai/gpt-4o-mini\n');
    expect(() => loadSpec(file)).toThrow(/'provider': .*; unknown field 'model' \(a spec sets the model under provider: \{ type: openai, model: gpt-4o-mini \}\)/);
  });
});
