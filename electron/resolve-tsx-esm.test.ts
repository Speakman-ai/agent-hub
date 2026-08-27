import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveTsxEsmPath } from './resolve-tsx-esm.mjs';

describe('resolveTsxEsmPath', () => {
  it('rewrites app.asar to app.asar.unpacked for a packaged build', () => {
    const electronDir = '/Applications/Agent Hub.app/Contents/Resources/app.asar/electron';
    const result = resolveTsxEsmPath(electronDir);
    // The regression: without the rewrite the shim loads from inside app.asar,
    // where server/** does not exist, and the app crashes at launch.
    expect(result).toBe(
      '/Applications/Agent Hub.app/Contents/Resources/app.asar.unpacked/server/node_modules/tsx/dist/esm.mjs',
    );
    expect(result).not.toContain('app.asar/server');
  });

  it('is a no-op in dev where there is no app.asar segment', () => {
    const electronDir = '/home/dev/agent-hub/electron';
    const result = resolveTsxEsmPath(electronDir);
    expect(result).toBe(
      path.join('/home/dev/agent-hub', 'server', 'node_modules', 'tsx', 'dist', 'esm.mjs'),
    );
    expect(result).not.toContain('unpacked');
  });
});
