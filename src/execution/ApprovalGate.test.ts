
import { StorageServiceApprovalStore } from './ApprovalGate';
import { describeApprovalStoreContract } from '../storage/sqlite/__fixtures__/storeContracts';
import { StorageService, FileSystemAdapter, PathAdapter } from '../storage/StorageService';

/**
 * A minimal in-memory fake of the Node fs/path modules, good enough to
 * exercise StorageService's real read/write/lock logic without touching
 * disk. Mirrors the mocking style already used in StorageService.test.ts,
 * but backs it with real state so round-trips are meaningful.
 */
function createFakeFs(): { fs: FileSystemAdapter; path: PathAdapter } {
  const files = new Map<string, string>();

  // Returns text only: StorageService reads with 'utf8' (the Buffer overload is unused).
  function readFileSync(p: string, encoding: 'utf8'): string;
  function readFileSync(p: string): Buffer;
  function readFileSync(p: string): string | Buffer {
    return files.get(p) as string;
  }

  const fs: FileSystemAdapter = {
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    readFileSync,
    rmSync: (p: string) => {
      files.delete(p);
    },
  };

  const path: PathAdapter = {
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) => parts.join('/'),
  };

  return { fs, path };
}

function createApprovalStore(): StorageServiceApprovalStore {
  const { fs, path } = createFakeFs();
  const storageService = new StorageService('test-db-hash', 'test-schema', fs, path, '/test/root');
  return new StorageServiceApprovalStore(storageService);
}

// The shared store contract, including the Uint8Array round-trip.
describeApprovalStoreContract('StorageServiceApprovalStore', createApprovalStore);
