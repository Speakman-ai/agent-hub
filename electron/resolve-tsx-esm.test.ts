import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveTsxEsmPath } from './resolve-tsx-esm.mjs';

describe('resolveTsxEsmPath', () => {
  it('rewrites app.asar to app.asar.unpacked for a packaged build', () => {
    const electronDir = '/Applications/Agent Hub.app/Contents/Resources/app.asar/electron';
    const result = resolveTsxEsmPath(electronDir);
    // The regression: without the rewrite the shim loads from inside app.asar,
    // where server/** does not exist, and the app crashes at launch.
    expect(result).toBe(
      '/Applications/Agent Hub.app/Contents/Resources/app.asar.unpacked/server/node_modules/tsx/dist/esm/index.mjs',
    );
    expect(result).not.toContain('app.asar/server');
  });

  it('is a no-op in dev where there is no app.asar segment', () => {
    const electronDir = '/home/dev/agent-hub/electron';
    const result = resolveTsxEsmPath(electronDir);
    expect(result).toBe(
      path.join('/home/dev/agent-hub', 'server', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
    );
    expect(result).not.toContain('unpacked');
  });

  // Guards against a tsx dist-layout change silently reintroducing the
  // launch-time ERR_MODULE_NOT_FOUND. In dev (no app.asar segment) the resolved
  // path points straight at the real on-disk loader. Skipped where server deps
  // are not installed (e.g. the electron CI shard installs only root + shared),
  // since there is no tsx to resolve against there.
  const electronDir = path.dirname(fileURLToPath(import.meta.url));
  const tsxDir = path.join(electronDir, '..', 'server', 'node_modules', 'tsx');
  const tsxInstalled = existsSync(tsxDir);

  it.skipIf(!tsxInstalled)('resolves to a loader file that exists in the installed tsx', () => {
    const result = resolveTsxEsmPath(electronDir);
    expect(existsSync(result)).toBe(true);
  });
});
