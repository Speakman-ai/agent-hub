/**
 * Build-time helper used by `vite.config.js` to resolve the app version that
 * gets baked into the client bundle as `VITE_APP_VERSION`.
 *
 * This file is imported only from `vite.config.js` (Node, build time). It is
 * NOT imported from any runtime code, so it stays out of the shipped bundle.
 *
 * Sources, in priority order:
 *   1. `env.VITE_APP_VERSION` — explicit override for build pipelines that
 *      already know the version (CI builds, Docker `--build-arg`).
 *   2. `rootPkgPath` — read `version` from the repo-root package.json
 *      (the only file release-all.yml bumps on every release).
 *
 * We deliberately do NOT fall back to `client/package.json`. That file's
 * version is not bumped by the release workflow and is stuck at an old
 * number; falling back to it produces a bundle that reports a wildly stale
 * version (e.g. "v1.2.1" while the real app is at v1.25.5) — see the
 * "App still shows a version behind" bug for the production fallout.
 *
 * Test-only injection points:
 *   - `readFile` lets tests stub the file system without mocking `fs`.
 */
export function resolveBuildVersion({ env, rootPkgPath, readFile } = {}) {
  const fromEnv = typeof env?.VITE_APP_VERSION === 'string' ? env.VITE_APP_VERSION.trim() : '';
  if (fromEnv) return fromEnv;
  if (!rootPkgPath) {
    throw new Error('resolveBuildVersion: rootPkgPath is required when VITE_APP_VERSION is unset');
  }
  if (typeof readFile !== 'function') {
    throw new Error('resolveBuildVersion: readFile is required when VITE_APP_VERSION is unset');
  }
  const raw = readFile(rootPkgPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (typeof parsed?.version !== 'string' || !parsed.version.trim()) {
    throw new Error(`resolveBuildVersion: ${rootPkgPath} has no usable "version" field`);
  }
  return parsed.version.trim();
}
