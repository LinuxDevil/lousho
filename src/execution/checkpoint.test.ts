
import { LocalStorageCheckpointStore } from './checkpoint';
import { StorageService } from '../storage/StorageService';
import { createFakeFs } from './__fixtures__/fakeFs';
import { describeCheckpointStoreContract } from '../storage/sqlite/__fixtures__/storeContracts';

function createCheckpointStore(): LocalStorageCheckpointStore {
  const { fs, path } = createFakeFs();
  const storageService = new StorageService('test-db-hash', 'test-schema', fs, path, '/test/root');
  return new LocalStorageCheckpointStore(storageService);
}

// The shared store contract, including the Uint8Array round-trip.
describeCheckpointStoreContract('LocalStorageCheckpointStore', createCheckpointStore);
