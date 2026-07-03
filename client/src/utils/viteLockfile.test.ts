import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Regression guard for the vite 6.4.3 lockfile corruption that broke the
// Docker client build (`Cannot find package 'fdir' imported from
// vite/dist/node/cli.js`).
//
// The security-audit bump hand-edited the `node_modules/vite` entry in
// client/package-lock.json to version 6.4.3 (new resolved/integrity) but kept
// the stale Vite-5 dependency metadata: it declared `esbuild@^0.21.3` and
// omitted `fdir`, `picomatch`, and `tinyglobby` (all direct deps of vite 6.x).
// Because npm considered 6.4.3 to already satisfy `^6.4.3`, neither `npm
// install` nor `npm install --package-lock-only` re-resolved it, so `npm ci`
// followed the broken graph, never hoisted a resolvable `fdir` node, and the
// vite build died with ERR_MODULE_NOT_FOUND.
//
// The client unit tests mock/never import vite's CLI, so they can't catch a
// broken lockfile. This test reads the real lockfile and asserts the vite
// entry is self-consistent: it is a genuine npm-resolved 6.x entry, declares
// the deps vite 6.x actually imports, and every required (non-optional)
// dependency it declares has a resolvable package node in the same lockfile.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lockfilePath = path.resolve(__dirname, '../../package-lock.json');

interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8')) as {
  packages: Record<string, LockPackage>;
};

/**
 * Resolve a dependency `name` as npm would from the package at `fromPath`:
 * walk up the node_modules nesting chain, preferring the most deeply nested
 * `node_modules/<name>` entry, falling back to the hoisted top-level one.
 */
function hasResolvableNode(fromPath: string, name: string): boolean {
  // Check the package's own nested node_modules first (e.g. vite bundles fdir
  // under node_modules/vite/node_modules/fdir), then walk up each ancestor's
  // node_modules, then fall back to the hoisted top-level entry.
  let scope = fromPath;
  while (true) {
    if (lockfile.packages[`${scope}/node_modules/${name}`]) return true;
    const idx = scope.lastIndexOf('/node_modules/');
    if (idx === -1) break;
    scope = scope.slice(0, idx);
  }
  return Boolean(lockfile.packages[`node_modules/${name}`]);
}

describe('client package-lock.json vite entry', () => {
  const vite = lockfile.packages['node_modules/vite'];

  it('exists as a genuine npm-resolved entry (not a hand-edited stub)', () => {
    expect(vite, 'node_modules/vite missing from lockfile').toBeTruthy();
    expect(vite.version, 'vite should be pinned to a 6.x version').toMatch(/^6\./);
    expect(vite.resolved, 'vite entry must carry a resolved tarball URL').toContain('vite');
    expect(vite.integrity, 'vite entry must carry an integrity hash').toMatch(/^sha/);
  });

  it('declares the direct deps vite 6.x imports (fdir/picomatch/tinyglobby)', () => {
    const deps = vite.dependencies ?? {};
    // `fdir` is the exact package whose absence broke the Docker build.
    expect(deps, 'vite 6.x must declare fdir').toHaveProperty('fdir');
    expect(deps, 'vite 6.x must declare picomatch').toHaveProperty('picomatch');
    expect(deps, 'vite 6.x must declare tinyglobby').toHaveProperty('tinyglobby');
    // The stale Vite-5 esbuild range is the fingerprint of the bad hand-edit.
    expect(deps.esbuild, 'vite 6.x uses esbuild ^0.25, not the Vite-5 ^0.21').not.toMatch(
      /\^0\.21\./,
    );
  });

  it('resolves every required dependency to a package node in the lockfile', () => {
    const deps = vite.dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      expect(
        hasResolvableNode('node_modules/vite', dep),
        `vite dependency "${dep}" has no resolvable node in package-lock.json`,
      ).toBe(true);
    }
  });
});
