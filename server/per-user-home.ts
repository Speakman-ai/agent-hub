/**
 * Per-user HOME — isolates CLI cache directories (`.cursor`, `.codex`,
 * `.gemini`, etc.) per authenticated Hub user.
 *
 * ## The problem this solves
 *
 * Several CLI engines (Cursor Agent, Codex, Gemini) authenticate by
 * writing OAuth tokens into the operator's HOME directory:
 *   - `~/.cursor/`             (Cursor Agent)
 *   - `~/.codex/auth.json`     (Codex device-auth)
 *   - `~/.gemini/`             (Gemini CLI, OAuth path)
 *
 * On a multi-user Hub these caches are effectively singletons — every
 * spawn lands under the same `agenthub` user HOME and shares whatever
 * account was last signed in by an Admin. There is no per-user identity
 * binding on the CLI side.
 *
 * ## How the per-user HOME fixes it
 *
 * `buildSpawnEnv({ userId })` redirects HOME for that spawn to
 * `<dataDir>/per-user-creds/<userId>/home`. The CLI then writes its
 * cache under that subtree, scoped to one Hub user:
 *
 *   <dataDir>/per-user-creds/<userId>/home/.cursor
 *   <dataDir>/per-user-creds/<userId>/home/.codex
 *
 * Per-user login endpoints (`/api/auth/me/cursor-auth/login`,
 * `/api/auth/me/codex-auth/device-login`) spawn the CLIs with this HOME
 * so the OAuth handshake lands in the right cache; every downstream
 * spawn for sessions owned by the same user inherits the same HOME and
 * therefore the same authenticated account.
 *
 * The legacy host-wide auth flows (`/api/config/cursor-auth/login`,
 * `/api/config/codex-auth/device-login`) keep writing to the operator's
 * HOME — they're a separate code path, gated by Admin role, and we
 * intentionally don't migrate their state into per-user caches.
 *
 * ## Security
 *
 * - Directory is created with mode 0700; only the OS user running the
 *   server (which is also the OS user every spawn runs as) can read it.
 * - User id is validated against a strict charset before becoming a
 *   path segment — defence-in-depth against directory traversal.
 * - When the user clears their per-user cache via DELETE the on-disk
 *   `.cursor` / `.codex` directories are removed; the parent
 *   `<userId>/home` dir is kept so the next login can reuse the same
 *   tree without re-creating the path.
 */
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';

const ROOT_SUBDIR = 'per-user-creds';
const HOME_SUBDIR = 'home';
/** Accept UUIDs (with hyphens) and the test-friendly slug variants. */
const USER_ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

function assertSafeUserId(userId: string): void {
  if (!USER_ID_REGEX.test(userId) || userId === '.' || userId === '..') {
    throw new Error(`per-user-home: invalid userId ${JSON.stringify(userId)}`);
  }
}

/** Directory that holds all per-user cred trees for a given data dir. */
export function perUserCredsRoot(dataDir: string): string {
  return path.join(dataDir, ROOT_SUBDIR);
}

/**
 * The per-user HOME we point CLI spawns at. Caller is responsible for
 * calling `ensurePerUserHome` before relying on the directory existing.
 */
export function perUserHomePath(userId: string, dataDir: string): string {
  assertSafeUserId(userId);
  return path.join(perUserCredsRoot(dataDir), userId, HOME_SUBDIR);
}

/**
 * Create the per-user HOME directory tree (mode 0700) if it doesn't
 * already exist. Returns the absolute path.
 *
 * Best-effort: filesystem errors throw to the caller, which is the
 * spawn pipeline. `buildSpawnEnv` swallows those and falls back to the
 * host HOME so a transient FS error can never block a spawn.
 */
export function ensurePerUserHome(userId: string, dataDir: string): string {
  const home = perUserHomePath(userId, dataDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Lock down the parent <userId> directory too — `recursive: true` on
  // mkdirSync only applies the mode to leaves it had to create, so the
  // intermediate may have been left with the default umask. Re-applying
  // is idempotent.
  try {
    mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  } catch {
    /* dir already exists with whatever perms it had */
  }
  return home;
}

/**
 * Remove a single CLI cache subdirectory under the per-user HOME.
 * No-op when the directory doesn't exist. Used by DELETE handlers when
 * a user signs out of Cursor / Codex from My Auth.
 *
 * `subdir` must be a leaf name like `.cursor` or `.codex`. Path
 * separators are rejected to keep this from being a generic delete
 * primitive.
 */
export function clearPerUserCliCache(userId: string, dataDir: string, subdir: string): void {
  if (subdir.includes('/') || subdir.includes(path.sep) || subdir === '.' || subdir === '..') {
    throw new Error(`per-user-home: invalid subdir ${JSON.stringify(subdir)}`);
  }
  const home = perUserHomePath(userId, dataDir);
  const target = path.join(home, subdir);
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
}
