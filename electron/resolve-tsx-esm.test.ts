import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveTsxApiPath } from './resolve-tsx-esm.mjs';

describe('resolveTsxApiPath', () => {
  it('rewrites app.asar to app.asar.unpacked for a packaged build', () => {
    const electronDir = '/Applications/Agent Hub.app/Contents/Resources/app.asar/electron';
    const result = resolveTsxApiPath(electronDir);
    // The regression: without the rewrite the shim loads from inside app.asar,
    // where server/** does not exist, and the app crashes at launch.
    expect(result).toBe(
      '/Applications/Agent Hub.app/Contents/Resources/app.asar.unpacked/server/node_modules/tsx/dist/esm/api/index.mjs',
    );
    expect(result).not.toContain('app.asar/server');
  });

  it('is a no-op in dev where there is no app.asar segment', () => {
    const electronDir = '/home/dev/agent-hub/electron';
    const result = resolveTsxApiPath(electronDir);
    expect(result).toBe(
      path.join(
        '/home/dev/agent-hub',
        'server',
        'node_modules',
        'tsx',
        'dist',
        'esm',
        'api',
        'index.mjs',
      ),
    );
    expect(result).not.toContain('unpacked');
  });

  // Guards against a tsx dist-layout change silently reintroducing the
  // launch-time crash. We resolve tsx's programmatic register API (NOT the bare
  // loader) because since tsx 4.19 hand-registering the loader throws
  // "tsx must be loaded with --import instead of --loader". In dev (no app.asar
  // segment) the resolved path points straight at the real on-disk api entry.
  // Skipped where server deps are not installed (e.g. the electron CI shard
  // installs only root + shared), since there is no tsx to resolve against.
  const electronDir = path.dirname(fileURLToPath(import.meta.url));
  const tsxDir = path.join(electronDir, '..', 'server', 'node_modules', 'tsx');
  const tsxInstalled = existsSync(tsxDir);

  it.skipIf(!tsxInstalled)('resolves to an api file that exists in the installed tsx', () => {
    const result = resolveTsxApiPath(electronDir);
    expect(existsSync(result)).toBe(true);
  });

  it.skipIf(!tsxInstalled)('resolves a module that exports a callable register()', async () => {
    const result = resolveTsxApiPath(electronDir);
    const mod = await import(pathToFileURL(result).href);
    // The whole point of using tsx/esm/api: register() installs the ESM hooks
    // with the init-data payload the raw loader now requires.
    expect(typeof mod.register).toBe('function');
  });
});
