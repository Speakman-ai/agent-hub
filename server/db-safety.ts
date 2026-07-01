/**
 * Fail-closed guards that keep test runs away from real databases.
 *
 * Incident 2026-07-01: a vitest run inside the production container inherited
 * `AGENT_HUB_DATA_DIR=/data` (the server exports its dataDir to every spawned
 * process), the vitest config/setup isolation never loaded, and the deploy
 * test files' unqualified `DELETE FROM kanban_boards` wiped every project's
 * kanban data (cards/columns/epics cascade), support tickets, and deployment
 * history in prod. Recovery took an EBS-snapshot restore plus transcript
 * forensics.
 *
 * The pre-existing rail in config.ts only fired when AGENT_HUB_TEST_MODE=1
 * (set by vitest.config.ts test.env — absent exactly when the config isn't
 * loaded) and only rejected the *default* data dir (an explicitly-inherited
 * prod path passed it). These guards close both holes:
 *
 *  - `assertSafeTestDataDir` runs on EVERY `initDb()` and refuses to open a
 *    database outside `os.tmpdir()` whenever a test runner is detected. It
 *    keys off `VITEST` / `VITEST_POOL_ID` / `NODE_ENV=test` /
 *    `AGENT_HUB_TEST_MODE`, which vitest sets in its workers regardless of
 *    whether any project config or setup file loaded.
 *  - `assertScratchDbFile` (used by server/test/destructive-db.ts) validates
 *    the concrete SQLite file path behind a handle before any bulk DELETE.
 *
 * Escape hatch: AGENT_HUB_ALLOW_UNSAFE_TEST_DB=1 — intentionally loud and
 * explicit; nothing in the repo sets it.
 */
import os from 'os';
import fs from 'fs';
import path from 'path';

/** True when the current process looks like a test-runner worker. */
export function isTestContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.VITEST ||
    env.VITEST_POOL_ID ||
    env.VITEST_WORKER_ID ||
    env.NODE_ENV === 'test' ||
    env.AGENT_HUB_TEST_MODE === '1',
  );
}

/** Resolve a path to its real location when it (or an ancestor) exists. */
function realResolve(p: string): string {
  const resolved = path.resolve(p);
  // realpath the deepest existing ancestor so not-yet-created dirs still
  // compare correctly through symlinks (macOS /tmp → /private/tmp).
  let probe = resolved;
  let suffix = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), suffix);
    } catch (err) {
      // Only walk up for "this component doesn't exist" errors. Anything
      // else (EACCES, EIO, …) means the path exists but can't be resolved —
      // fall back to the plain resolved path, which compares conservatively.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return resolved;
      const parent = path.dirname(probe);
      if (parent === probe) return resolved; // hit fs root without existing
      suffix = path.join(path.basename(probe), suffix);
      probe = parent;
    }
  }
}

/** Is `child` located at or below `parent` (after symlink resolution)? */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(realResolve(parent), realResolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Is this file/dir path safe for destructive test use? */
export function isScratchPath(p: string): boolean {
  if (p === ':memory:' || p === '') return true; // in-memory SQLite
  return isPathInside(p, os.tmpdir());
}

export class UnsafeTestDatabaseError extends Error {
  constructor(what: string, where: string) {
    super(
      `[db-safety] REFUSING ${what}: "${where}" is outside os.tmpdir() (${os.tmpdir()}) ` +
        'while running under a test runner. Tests must never touch a real database — ' +
        'a prod run of the deploy tests wiped every kanban board on 2026-07-01. ' +
        'Fix the test isolation (vitest.config.ts + server/test/setup.ts must set ' +
        'AGENT_HUB_DATA_DIR to a tmp dir). If you are ABSOLUTELY sure, set ' +
        'AGENT_HUB_ALLOW_UNSAFE_TEST_DB=1 to override.',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

/**
 * Fail-closed gate for opening a database directory. No-op outside test
 * context; throws when a test runner would open a DB outside tmpdir.
 */
export function assertSafeTestDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isTestContext(env)) return;
  if (env.AGENT_HUB_ALLOW_UNSAFE_TEST_DB === '1') return;
  if (isScratchPath(dataDir)) return;
  throw new UnsafeTestDatabaseError('to open database dir', dataDir);
}

/**
 * Fail-closed gate for destructive statements against an already-open
 * SQLite handle. Unlike `assertSafeTestDataDir` it does not require test
 * context — bulk table wipes have no legitimate non-scratch target from
 * any context — so only the explicit AGENT_HUB_ALLOW_UNSAFE_TEST_DB=1
 * escape hatch bypasses it.
 */
export function assertScratchDbFile(
  dbFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.AGENT_HUB_ALLOW_UNSAFE_TEST_DB === '1') return;
  if (isScratchPath(dbFilePath)) return;
  throw new UnsafeTestDatabaseError('destructive operation on database', dbFilePath);
}
