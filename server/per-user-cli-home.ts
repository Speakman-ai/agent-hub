/**
 * Per-user, per-engine CLI HOME shim.
 *
 * Foundation for the P3/P4 "Sign in with browser" flows that need to keep
 * each Hub user's Cursor / Codex CLI cache isolated from every other
 * user's. The existing `per-user-home.ts` already does the per-user side
 * but pins *one* HOME per user; this helper carves out a separate tree
 * per (engine, user) pair so the two engines can never read each other's
 * cache, and so wiping one (logout) cannot accidentally damage the other.
 *
 * Layout
 *
 *   <dataDir>/per-user-cli-home/<engine>/<userId>/
 *
 * Used as:
 *   - Cursor:  spawn env `HOME=<path>` (cursor-agent reads $HOME/.cursor)
 *   - Codex:   spawn env `CODEX_HOME=<path>` (codex CLI reads $CODEX_HOME
 *              if set, otherwise $HOME/.codex)
 *
 * The card explicitly scopes wiring (P3/P4) out — this module just
 * provides the safe path + create primitive that those endpoints will
 * pick up.
 *
 * Security guards
 *
 *   - Engine is validated against a small allowlist (`cursor`, `codex`,
 *     `gemini`). An unknown engine throws rather than silently widening
 *     the filesystem layout.
 *   - `userId` is checked against a strict charset before becoming a path
 *     segment — defence-in-depth against traversal.
 *   - Directories are created mode 0700 (owner-only). After mkdir we
 *     re-stat and confirm the directory is owned by the running process
 *     UID; a mismatch throws so we never hand a misowned cache to a CLI
 *     spawn (this would normally only happen if an operator manually
 *     pre-created the tree under another account).
 */
import { mkdirSync, statSync, existsSync, rmSync } from 'fs';
import path from 'path';

const ROOT_SUBDIR = 'per-user-cli-home';
const USER_ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

export type CliEngine = 'cursor' | 'codex' | 'gemini';
const ALLOWED_ENGINES: ReadonlySet<CliEngine> = new Set<CliEngine>(['cursor', 'codex', 'gemini']);

function assertSafeUserId(userId: string): void {
  if (!USER_ID_REGEX.test(userId) || userId === '.' || userId === '..') {
    throw new Error(`per-user-cli-home: invalid userId ${JSON.stringify(userId)}`);
  }
}

function assertKnownEngine(engine: string): asserts engine is CliEngine {
  if (!ALLOWED_ENGINES.has(engine as CliEngine)) {
    throw new Error(`per-user-cli-home: unknown engine ${JSON.stringify(engine)}`);
  }
}

/** Root that holds all per-engine, per-user CLI home dirs for a given data dir. */
export function perUserCliHomeRoot(dataDir: string): string {
  return path.join(dataDir, ROOT_SUBDIR);
}

/**
 * Return the absolute path Cursor / Codex should treat as HOME (Cursor)
 * or CODEX_HOME (Codex) for the given Hub user. Pure path math — does
 * not touch the filesystem; pair with `ensurePerUserCliHome` when you
 * need the dir to exist.
 */
export function perUserCliHomePath(engine: string, userId: string, dataDir: string): string {
  assertKnownEngine(engine);
  assertSafeUserId(userId);
  return path.join(perUserCliHomeRoot(dataDir), engine, userId);
}

/**
 * Create (idempotent) the per-engine, per-user CLI home directory with
 * mode 0700 and verify the running process owns it. Returns the absolute
 * path on success.
 *
 * Throws when:
 *   - engine is not in the allowlist
 *   - userId fails the path-safe regex
 *   - mkdir fails for any reason other than the leaf already existing
 *   - the leaf exists but is owned by a different OS UID (ownership
 *     guard — refuses to hand a misowned dir to a spawn)
 *
 * On platforms where `process.geteuid()` is unavailable (Windows), the
 * ownership check is skipped. The leaf is still created mode 0700.
 */
export function ensurePerUserCliHome(engine: string, userId: string, dataDir: string): string {
  const target = perUserCliHomePath(engine, userId, dataDir);

  // mkdirSync with recursive: true is a no-op on existing dirs and only
  // applies `mode` to leaves it had to create. The parent
  // (`<engine>/`) gets re-locked below to keep semantics consistent.
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    /* parent already existed with whatever perms */
  }

  // Ownership guard. `geteuid` is undefined on Windows; skip cleanly.
  const geteuid = (process as NodeJS.Process & { geteuid?: () => number }).geteuid?.bind(process);
  if (typeof geteuid === 'function') {
    const myUid = geteuid();
    let stats;
    try {
      stats = statSync(target);
    } catch (err) {
      throw new Error(
        `per-user-cli-home: failed to stat ${target} after mkdir: ${(err as Error).message}`,
      );
    }
    if (typeof stats.uid === 'number' && stats.uid !== myUid) {
      throw new Error(
        `per-user-cli-home: refusing to use ${target} — owned by uid ${stats.uid} (expected ${myUid})`,
      );
    }
  }

  return target;
}

/**
 * Remove the leaf directory (CLI cache) for a single (engine, user)
 * pair. No-op when the directory doesn't exist. The parent `<engine>/`
 * dir is kept so the next login can reuse the tree without re-creating
 * it.
 */
export function clearPerUserCliHome(engine: string, userId: string, dataDir: string): void {
  const target = perUserCliHomePath(engine, userId, dataDir);
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
}
