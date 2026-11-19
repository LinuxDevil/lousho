import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_DIRS = ['server', 'src', 'shared'];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

interface Newest {
  file: string;
  mtimeMs: number;
}

function newestSource(dir: string): Newest | undefined {
  let newest: Newest | undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('dist')) continue;
    const full = path.join(dir, entry.name);
    let candidate: Newest | undefined;
    if (entry.isDirectory()) candidate = newestSource(full);
    else if (entry.isFile() && !TEST_FILE.test(entry.name)) candidate = { file: full, mtimeMs: fs.statSync(full).mtimeMs };
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

export function assertStudioBundleFresh(studioDir: string): void {
  const bundle = path.join(studioDir, 'dist-server', 'cli.cjs');
  if (!fs.existsSync(bundle)) return;
  const bundleTime = fs.statSync(bundle).mtimeMs;
  let newest: Newest | undefined;
  for (const sub of SOURCE_DIRS) {
    const dir = path.join(studioDir, sub);
    if (!fs.existsSync(dir)) continue;
    const found = newestSource(dir);
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  if (newest && newest.mtimeMs > bundleTime) {
    throw new Error(
      `the Studio bundle is older than its sources (newest: ${path.relative(studioDir, newest.file)}); run \`npm run build:studio\` in apps/agent-forge, then deploy again`
    );
  }
}
