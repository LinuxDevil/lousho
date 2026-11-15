import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SDKError, ValidationError } from '../../execution/errors';
import { artifactSink, blobArtifactStore, type BlobClient, memoryArtifactStore, memoryBlobClient, type ArtifactScope, type ArtifactStore, type ArtifactStoreOptions } from './artifacts';
import { fileArtifactStore } from './fileArtifactStore';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lousho-artifacts-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const STORES: [string, (options?: ArtifactStoreOptions) => Promise<ArtifactStore>][] = [
  ['file', async (options) => fileArtifactStore(await tempRoot(), options)],
  ['blob', async (options) => blobArtifactStore(memoryBlobClient(), options)],
  ['memory', async (options) => memoryArtifactStore(options)],
];

const pageA: ArtifactScope = { workspace: 'marketing', runId: 'run-a' };
const pageB: ArtifactScope = { workspace: 'marketing', runId: 'run-b' };

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

describe('artifact store', () => {
  it('put then get round-trips with sha, for both stores', async () => {
    for (const [, make] of STORES) {
      const store = await make();
      const text = await store.put(pageA, 'post 1.md', '# Hello', 'text/markdown');
      expect(text).toEqual({ name: 'post 1.md', mediaType: 'text/markdown', uri: 'artifact://marketing/run-a/post%201.md', bytes: 7, sha256: sha('# Hello') });
      expect(await store.get(text.uri, pageA)).toEqual({ ref: text, data: new TextEncoder().encode('# Hello') });

      const bytes = new Uint8Array([0, 1, 2, 255]);
      const binary = await store.put(pageA, 'clip.bin', bytes, 'application/octet-stream');
      expect(binary.sha256).toBe(sha(bytes));
      expect((await store.get(binary.uri, pageA))?.data).toEqual(bytes);

      const streamed = await artifactSink(store, pageA).put('script.txt', chunks('one ', 'two'), 'text/plain');
      expect(streamed).toMatchObject({ bytes: 7, sha256: sha('one two') });
      expect(new TextDecoder().decode((await store.get(streamed.uri, pageA))?.data)).toBe('one two');

      expect(await store.get('artifact://marketing/run-a/missing.md', pageA)).toBeUndefined();
    }
  });

  it("a page cannot get another page's artifact", async () => {
    for (const [, make] of STORES) {
      const store = await make();
      const ref = await store.put(pageA, 'a.md', 'secret', 'text/markdown');
      await expect(store.get(ref.uri, pageB)).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_FORBIDDEN' });
      await expect(store.get(ref.uri, { workspace: 'coding', runId: 'run-a' })).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_FORBIDDEN' });
      await expect(store.get(ref.uri, { ...pageB, refs: ['artifact://marketing/run-a/other.md'] })).rejects.toBeInstanceOf(SDKError);
      expect((await store.get(ref.uri, { ...pageB, refs: [ref.uri] }))?.ref).toEqual(ref);
      expect((await store.get('artifact://marketing/run-a/%61.md', { ...pageB, refs: [ref.uri] }))?.ref).toEqual(ref);
      await expect(store.get(ref.uri, { workspace: 'coding', runId: 'run-b', refs: [ref.uri] })).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_FORBIDDEN' });
    }
  });

  it('caps the size of an artifact with maxArtifactBytes, for every store', async () => {
    for (const [, make] of STORES) {
      const store = await make({ maxArtifactBytes: 4 });
      await expect(store.put(pageA, 'big.bin', chunks('ab', 'cde'), 'application/octet-stream')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_TOO_LARGE' });
      expect(await store.get('artifact://marketing/run-a/big.bin', pageA)).toBeUndefined();
      expect((await store.put(pageA, 'ok.bin', 'abcd', 'application/octet-stream')).bytes).toBe(4);
    }
  });

  it('keeps an artifact immutable: the same content is accepted again, other content is refused', async () => {
    for (const [, make] of STORES) {
      const store = await make();
      const ref = await store.put(pageA, 'a.md', 'one', 'text/markdown');
      expect(await store.put(pageA, 'a.md', 'one', 'text/markdown')).toEqual(ref);
      await expect(store.put(pageA, 'a.md', 'two', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
      await expect(store.put(pageA, 'a.md', 'one', 'text/plain')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
      expect(new TextDecoder().decode((await store.get(ref.uri, pageA))?.data)).toBe('one');
    }
  });

  it('refuses bad names, uris and media types before writing anything', async () => {
    for (const [, make] of STORES) {
      const store = await make();
      for (const name of ['', '..', '.hidden', '../x', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(256)]) {
        await expect(store.put(pageA, name, 'x', 'text/plain')).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(store.put({ workspace: 'Bad', runId: 'run' }, 'a.md', 'x', 'text/plain')).rejects.toBeInstanceOf(ValidationError);
      await expect(store.put({ workspace: 'marketing', runId: '..' }, 'a.md', 'x', 'text/plain')).rejects.toBeInstanceOf(ValidationError);
      for (const mediaType of ['', 'text', 'text/plain\r\nx: y', 'a/b'.repeat(100)]) {
        await expect(store.put(pageA, 'a.md', 'x', mediaType)).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(store.get('https://example.com/a.md', pageA)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('refuses an existing blob key with a conditional put, even when head missed it', async () => {
    const client = memoryBlobClient();
    expect(await client.put('k', new Uint8Array([1]), {}, { ifAbsent: true })).toBe(true);
    expect(await client.put('k', new Uint8Array([2]), {}, { ifAbsent: true })).toBe(false);
    expect((await client.get('k'))?.data).toEqual(new Uint8Array([1]));
    const inner = memoryBlobClient();
    let headCalls = 1;
    const racing: BlobClient = { put: inner.put, get: inner.get, head: (key) => (headCalls++ === 0 ? Promise.resolve(undefined) : inner.head(key)) };
    const store = blobArtifactStore(racing);
    const ref = await store.put(pageA, 'a.md', 'one', 'text/markdown');
    headCalls = 0;
    expect(await store.put(pageA, 'a.md', 'one', 'text/markdown')).toEqual(ref);
    headCalls = 0;
    await expect(store.put(pageA, 'a.md', 'two', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_ARTIFACT_EXISTS' });
    expect(new TextDecoder().decode((await store.get(ref.uri, pageA))?.data)).toBe('one');
    const vanished = blobArtifactStore({ put: () => Promise.resolve(false), get: inner.get, head: () => Promise.resolve(undefined) });
    await expect(vanished.put(pageA, 'b.md', 'x', 'text/markdown')).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED' });
  });
});
