import { readFileSync, writeFileSync } from 'node:fs';

const file = 'node_modules/tsup/dist/rollup.js';
const anchor = 'logCache("HIT", cacheKey);';
const fix = 'if (overrideConfigPath) dirName = path__namespace.dirname(path__namespace.resolve(process.cwd(), overrideConfigPath));';
const src = readFileSync(file, 'utf8');
if (!src.includes(fix)) {
  if (!src.includes(anchor)) throw new Error(`patch-tsup: anchor not found in ${file}; tsup changed, re-check the dts cache bug`);
  writeFileSync(file, src.replace(anchor, `${anchor}\n        ${fix}`));
}
