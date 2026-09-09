#!/usr/bin/env node
/**
 * Copies non-TypeScript runtime assets into dist/ after compilation.
 *
 * Templates and CSL style files are resolved relative to the directory the
 * running module lives in, so the same lookup works under tsx (src/) and under
 * node (dist/) with no environment-specific path handling.
 */
import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const directories = [
  ['src/views', 'dist/views'],
  ['src/citations/styles', 'dist/citations/styles'],
];

for (const [from, to] of directories) {
  const target = join(root, to);
  await rm(target, { recursive: true, force: true });
  await cp(join(root, from), target, { recursive: true });
  console.log(`copy-assets: ${from} -> ${to}`);
}
