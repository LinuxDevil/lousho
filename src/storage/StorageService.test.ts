import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from './StorageService';

// Mock fs module
const makeMockFs = () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
});

// Mock path module
const makeMockPath = () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  resolve: vi.fn((...args: string[]) => args.join('/')),
});

describe('Storage - StorageService', () => {
  let mockFs: ReturnType<typeof makeMockFs>;
  let mockPath: ReturnType<typeof makeMockPath>;
  let storageService: StorageService;

  beforeEach(() => {
    mockFs = makeMockFs();
    mockPath = makeMockPath();

    storageService = new StorageService(
      'test-db-hash',
      'test-schema',
      mockFs,
      mockPath,
      '/test/root'
    );
  });

  describe('savePlainTextAttachment', () => {
    it('should save text file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      await storageService.savePlainTextAttachment('Hello World', 'test.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        'Hello World',
        'utf8'
      );
    });

    it('should create directory if it does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      await storageService.savePlainTextAttachment('Test', 'test.txt');
      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('readPlainTextAttachment', () => {
    it('should read text file', () => {
      mockFs.readFileSync.mockReturnValue('File Content');
      const content = storageService.readPlainTextAttachment('test.txt');
      expect(content).toBe('File Content');
      expect(mockFs.readFileSync).toHaveBeenCalledWith(expect.any(String), 'utf8');
    });
  });

  describe('acquireLock', () => {

    it('should throw error if cannot acquire lock after max attempts', async () => {
      mockFs.existsSync.mockReturnValue(true);
      await expect(
        storageService.acquireLock('test.txt', 2, 10)
      ).rejects.toThrow('Could not acquire lock');
    });
  });

  describe('saveAttachmentFromBase64', () => {
    it('should save file from base64 string', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const base64 = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      await storageService.saveAttachmentFromBase64(base64, 'test.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });
});
