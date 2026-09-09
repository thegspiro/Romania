#!/usr/bin/env node
/**
 * Copies browser-side libraries out of node_modules into public/vendor.
 *
 * The public site loads no third-party CDN: visitors to the public pages must
 * not be exposed to a third party that can log their IP or serve different
 * code than we reviewed. Vendoring here keeps the assets pinned to the exact
 * versions in package-lock.json without committing binaries to git.
 */
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'public', 'vendor');

/** @type {{ from: string, to: string }[]} */
const assets = [
  { from: 'node_modules/leaflet/dist/leaflet.js', to: 'leaflet/leaflet.js' },
  { from: 'node_modules/leaflet/dist/leaflet.css', to: 'leaflet/leaflet.css' },
  { from: 'node_modules/leaflet/dist/images', to: 'leaflet/images' },
  { from: 'node_modules/cytoscape/dist/cytoscape.min.js', to: 'cytoscape/cytoscape.min.js' },
  {
    from: 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',
    to: 'simplewebauthn/browser.umd.min.js',
  },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await rm(vendorDir, { recursive: true, force: true });

let copied = 0;
for (const asset of assets) {
  const source = join(root, asset.from);
  const target = join(vendorDir, asset.to);

  if (!(await exists(source))) {
    console.error(`vendor-assets: missing ${asset.from} - run "npm install" first`);
    process.exitCode = 1;
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  copied += 1;
}

console.log(`vendor-assets: copied ${copied}/${assets.length} assets into public/vendor`);
