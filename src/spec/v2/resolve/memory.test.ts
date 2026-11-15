import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { memoryKey } from '../../../memory/defineMemory';
import type { EmbeddingProvider } from '../../../memory/embeddings';
import type { MemorySpec } from '../memory';
import { memoryFromSpec } from './memory';

const dirs: string[] = [];
const baseDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-memory-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A sqlite-vector slot keeps its database open; Windows then refuses to
      // delete it, so the temp dir is left for the OS.
    }
  }
});

const hasNodeSqlite = (() => {
  try {
    return (process.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: unknown } | undefined)?.DatabaseSync !== undefined;
  } catch {
    return false;
  }
})();

const fakeEmbedder: EmbeddingProvider = { id: 'fake', embed: async (texts) => texts.map(() => [1, 0]) };

describe('memoryFromSpec', () => {

  it.skipIf(!hasNodeSqlite)('compiles sqlite-vector through host.resolveEmbedder and stores items', async () => {
    const resolveEmbedder = async (id: string) => {
      expect(id).toBe('fake/embed');
      return fakeEmbedder;
    };
    const spec: MemorySpec = { name: 'notes', scope: 'global', provider: { type: 'sqlite-vector', embedder: 'fake/embed' } };
    const dir = baseDir();
    const slot = await memoryFromSpec(spec, { baseDir: dir, resolveEmbedder });
    expect(existsSync(path.join(dir, '.lousho', 'memory.db'))).toBe(true);
    const key = memoryKey(slot)!;
    await slot.provider.add(key, { text: 'a vector fact' });
    expect((await slot.provider.list(key)).map((item) => item.text)).toEqual(['a vector fact']);
  });
});
