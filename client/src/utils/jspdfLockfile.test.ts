import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Regression guard for PR #223 (jspdf 2.x -> 4.x bump).
//
// The original bump hand-edited the `node_modules/jspdf` entry in
// client/package-lock.json to version 4.2.1 but kept the stale 2.x dependency
// metadata: it declared `atob`/`btoa` (gone in 4.x) and omitted `fast-png`
// (added in 4.x), and it had no `resolved`/`integrity`. Because npm considered
// 4.2.1 to already satisfy `^4.2.1`, a plain `npm install` did NOT correct it,
// so `npm ci` followed the broken graph and `import('jspdf')` blew up at
// runtime with `Cannot find module 'fast-png'`.
//
// The exportDesignPdf unit tests mock `jspdf`, so they can't catch a broken
// lockfile. This test reads the real lockfile and asserts the jspdf entry is
// self-consistent: it is a genuine npm-resolved entry, and every required
// (non-optional) dependency it declares has a corresponding package node in
// the same lockfile.

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
  // Strip trailing "/node_modules/<pkg>" segments to walk up the tree.
  let prefix = fromPath;
  let idx = prefix.lastIndexOf('/node_modules/');
  while (idx !== -1) {
    const candidate = `${prefix}/node_modules/${name}`;
    if (lockfile.packages[candidate]) return true;
    prefix = prefix.slice(0, idx);
    idx = prefix.lastIndexOf('/node_modules/');
  }
  return Boolean(lockfile.packages[`node_modules/${name}`]);
}

describe('client package-lock.json jspdf entry', () => {
  const jspdf = lockfile.packages['node_modules/jspdf'];

  it('exists as a genuine npm-resolved entry (not a hand-edited stub)', () => {
    expect(jspdf, 'node_modules/jspdf missing from lockfile').toBeTruthy();
    expect(jspdf.version, 'jspdf should be pinned to a 4.x version').toMatch(/^4\./);
    // A hand-edited entry typically lacks these; npm always writes them.
    expect(jspdf.resolved, 'jspdf entry must carry a resolved tarball URL').toContain('jspdf');
    expect(jspdf.integrity, 'jspdf entry must carry an integrity hash').toMatch(/^sha/);
  });

  it('no longer declares the removed 2.x deps atob/btoa', () => {
    const deps = jspdf.dependencies ?? {};
    expect(deps).not.toHaveProperty('atob');
    expect(deps).not.toHaveProperty('btoa');
  });

  it('declares fast-png and resolves every required dependency in the lockfile', () => {
    const deps = jspdf.dependencies ?? {};
    expect(deps, 'jspdf 4.x must declare fast-png').toHaveProperty('fast-png');

    for (const dep of Object.keys(deps)) {
      expect(
        hasResolvableNode('node_modules/jspdf', dep),
        `jspdf dependency "${dep}" has no resolvable node in package-lock.json`,
      ).toBe(true);
    }
  });
});
