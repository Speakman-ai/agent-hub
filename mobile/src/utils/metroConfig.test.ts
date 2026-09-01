// @ts-nocheck
import path from 'path';
import { describe, it, expect } from 'vitest';
import { withAppNodeModulesResolverPaths } from '../../metro-shared-js-resolver.cjs';

// Regression coverage for the resolver-path change in `mobile/metro.config.js`.
//
// The mobile app imports shared modules from `<repoRoot>/shared`, some of which
// `import 'react'`. On EAS only `mobile/` gets `npm install`, so Metro's
// hierarchical lookup up the `shared/` tree finds no `react` and the eager
// "Bundle JavaScript" phase fails. The config fixes this by prepending the
// app's own `node_modules` to `config.resolver.nodeModulesPaths`.
//
// The `sharedJsFallbackSpecifier` helper has its own suite; before this, nothing
// exercised the resolver-root change. Deleting or breaking `nodeModulesPaths`
// would leave CI green and silently recreate the EAS failure. Two layers cover
// it: (1) the pure `withAppNodeModulesResolverPaths` helper the config delegates
// to, and (2) loading the real config to assert the helper is actually wired in.

const APP_NM = '/repo/mobile/node_modules';

describe('withAppNodeModulesResolverPaths', () => {
  it('prepends the app node_modules as the first resolver root', () => {
    expect(withAppNodeModulesResolverPaths([], APP_NM)[0]).toBe(APP_NM);
  });

  it('preserves existing resolver paths and their order', () => {
    const existing = ['/a/node_modules', '/b/node_modules'];
    expect(withAppNodeModulesResolverPaths(existing, APP_NM)).toEqual([
      APP_NM,
      '/a/node_modules',
      '/b/node_modules',
    ]);
  });

  it('does not drop any pre-existing paths (augments, never replaces)', () => {
    const existing = ['/a/node_modules', '/b/node_modules'];
    const result = withAppNodeModulesResolverPaths(existing, APP_NM);
    for (const p of existing) expect(result).toContain(p);
  });

  it('treats an unset (undefined) resolver-roots array as empty', () => {
    expect(withAppNodeModulesResolverPaths(undefined, APP_NM)).toEqual([APP_NM]);
  });

  it('de-duplicates so the app dir is never listed twice', () => {
    const existing = [APP_NM, '/a/node_modules'];
    const result = withAppNodeModulesResolverPaths(existing, APP_NM);
    expect(result.filter((p) => p === APP_NM)).toHaveLength(1);
    expect(result[0]).toBe(APP_NM);
    expect(result).toContain('/a/node_modules');
  });
});

// This suite loads the real `metro.config.js` — it needs `expo/metro-config`
// (present after `npm ci` in CI's mobile job). It catches the exact regression
// the reviewer flagged: removing the `nodeModulesPaths` line here turns CI red.
const projectRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(projectRoot, '..');

describe('mobile metro.config wiring', () => {
  it('keeps mobile/node_modules as the first resolver root', () => {
    const config = require('../../metro.config.js');
    expect(config.resolver.nodeModulesPaths[0]).toBe(path.join(projectRoot, 'node_modules'));
  });

  it('retains mobile/node_modules in the resolver paths', () => {
    const config = require('../../metro.config.js');
    expect(config.resolver.nodeModulesPaths).toContain(path.join(projectRoot, 'node_modules'));
  });

  it('adds the repo root as a watch folder so shared/ is bundled', () => {
    const config = require('../../metro.config.js');
    expect(config.watchFolders).toContain(repoRoot);
  });

  it('keeps the shared-".js"-specifier resolveRequest wired', () => {
    const config = require('../../metro.config.js');
    expect(typeof config.resolver.resolveRequest).toBe('function');
  });
});
