import { describe, expect, it } from 'vitest';
import { checkItem, formatFinding, scanSource } from './addCheck';
import type { RegistryItem } from './registry';

const tool = (content: string, permissions: RegistryItem['permissions'] = {}, path = 'tools/t.ts'): RegistryItem => ({
  name: 't',
  type: 'tool',
  description: '',
  files: [{ path, content }],
  permissions,
});

/** The refusing findings, formatted. */
const refused = (content: string, permissions: RegistryItem['permissions'] = {}): string[] =>
  checkItem(tool(content, permissions))
    .filter((finding) => finding.level === 'refuse')
    .map(formatFinding);

describe('checkItem', () => {
  describe('exec', () => {
    it.each([
      ["import { SubprocessSandbox } from 'lousho';"],
    ])('needs exec: true for %s', (code) => {
      expect(refused(code).join('\n')).toContain('declare exec: true in permissions');
      expect(refused(code, { exec: true })).toEqual([]);
    });
  });

  describe('filesystem', () => {
    it('needs read for an fs import, and write for a write call', () => {
      const read = "import { readFile } from 'node:fs/promises';\nexport const r = () => readFile('a.txt', 'utf8');";
      expect(refused(read)).toEqual(["tools/t.ts:1: import of 'node:fs/promises' (uses the filesystem) (declare filesystem: \"read\" or \"write\" in permissions)"]);
      expect(refused(read, { filesystem: 'read' })).toEqual([]);

      const write = "import * as fs from 'fs';\nfs.writeFileSync('a.txt', 'x');";
      expect(refused(write, { filesystem: 'read' })).toEqual(['tools/t.ts:2: a call to writeFileSync() (writes files) (declare filesystem: "write" in permissions)']);
      expect(refused(write, { filesystem: 'write' })).toEqual([]);
    });
  });

  describe('network', () => {
    it('needs network for fetch( and for a network module import', () => {
      expect(refused('export const go = () => fetch(url);')).toEqual(['tools/t.ts:1: a call to fetch() (uses the network) (declare network in permissions)']);
      expect(refused("import axios from 'axios';")).toEqual(["tools/t.ts:1: import of 'axios' (uses the network) (declare network in permissions)"]);
      expect(refused("import https from 'node:https';")).toHaveLength(1);
      expect(refused('export const go = () => fetch(url);', { network: ['api.example.com'] })).toEqual([]);
      expect(refused("import axios from 'axios';", { network: ['api.example.com'] })).toEqual([]);
    });

    it('checks every http(s) URL literal against the network patterns', () => {
      const code = "const a = 'https://api.example.com/v1';\nconst b = `https://evil.example.org/x?q=${q}`;";
      expect(refused(code, { network: ['api.example.com'] })).toEqual(['tools/t.ts:2: a URL to evil.example.org (declare network: ["evil.example.org"] in permissions)']);
      expect(refused(code, { network: ['api.example.com', '*.example.org'] })).toEqual([]);
      expect(refused("const u = 'https://user:pw@API.Example.com:8443/x';", { network: ['api.example.com'] })).toEqual([]);
    });

    it('notes a computed host when network is declared, and refuses it when not', () => {
      const code = 'const u = `https://${host}/x`;';
      expect(refused(code)).toEqual(['tools/t.ts:1: a URL whose host is computed (declare network in permissions)']);
      const findings = checkItem(tool(code, { network: ['api.example.com'] }));
      expect(findings.map((finding) => finding.level)).toEqual(['note']);
      expect(formatFinding(findings[0])).toContain('could not be checked');
    });
  });

  describe('env', () => {
    it('needs every dotted and bracketed name in env', () => {
      expect(refused('const k = process.env.SEARCH_KEY;')).toEqual(['tools/t.ts:1: reads process.env.SEARCH_KEY (declare env: ["SEARCH_KEY"] in permissions)']);
      expect(refused("const k = process.env['SEARCH_KEY'];")).toEqual(['tools/t.ts:1: reads process.env.SEARCH_KEY (declare env: ["SEARCH_KEY"] in permissions)']);
      expect(refused("const k = process.env.SEARCH_KEY ?? process.env['SEARCH_KEY'];", { env: ['SEARCH_KEY'] })).toEqual([]);
      expect(refused('const k = `Bearer ${process.env.SEARCH_KEY}`;', { env: ['OTHER'] })).toHaveLength(1);
    });

    it('refuses a computed read and process.env as a whole', () => {
      expect(refused('const k = process.env[name];', { env: ['A'] })).toEqual(['tools/t.ts:1: a computed process.env[...] read (never allowed in a registry item)']);
      expect(refused('const { A } = process.env;', { env: ['A'] })[0]).toContain('process.env used as a whole object');
    });
  });

  describe('scanning', () => {

    it('does not mistake // in a string or a regex for a comment', () => {
      expect(refused("const u = 'https://api.example.com'; fetch(u);", { network: ['api.example.com'] })).toEqual([]);
      expect(refused('const re = /https?:\\/\\//; eval(x);').join('\n')).toContain('eval(');
      expect(refused('const re = /[/*]/; eval(x); // */').join('\n')).toContain('eval(');
    });

    it('keeps the length and line breaks of the source', () => {
      const source = "a; // c\n'str' /* x\ny */ b";
      const scanned = scanSource(source);
      expect(scanned.code).toHaveLength(source.length);
      expect(scanned.bare).toHaveLength(source.length);
      expect(scanned.code.split('\n')).toHaveLength(3);
      expect(scanned.bare).not.toContain('str');
    });

    it('reports file and line for each finding, once per line', () => {
      const code = "export const a = 1;\n\nconst k = process.env.A + process.env.A;\neval('x');";
      expect(refused(code)).toEqual([
        'tools/t.ts:3: reads process.env.A (declare env: ["A"] in permissions)',
        "tools/t.ts:4: eval( (never allowed in a registry item)",
      ]);
    });

    it('refuses a module name written with escapes', () => {
      expect(refused("require('child\\x5fprocess');")[0]).toContain('escape sequences');
    });
  });
});
