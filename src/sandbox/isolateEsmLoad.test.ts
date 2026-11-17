import { expect, it, vi } from 'vitest';

class FakeIsolate {
  dispose(): void {}
  async createContext() {
    return {
      async evalClosure(code: string, args: unknown[]) {
        const run = new Function('$0', '$1', code) as ($0: unknown, $1: unknown) => unknown;
        return run(...(args as [unknown, unknown]));
      },
    };
  }
}

vi.mock('../providers/optionalPeer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/optionalPeer')>()),
  loadOptionalPeer: async () => ({ default: { Isolate: FakeIsolate } }),
}));

it("runs code when isolated-vm loads as an ESM namespace with only a default export", async () => {
  const { sandbox } = await import('./sandbox');
  const box = sandbox({ driver: 'isolate', timeoutMs: 2000 });
  await expect(box.run('(x) => x * 2', { args: [21] })).resolves.toBe(42);
});
