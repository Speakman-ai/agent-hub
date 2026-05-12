/**
 * Spawn-credentials file — per-session API token persisted to disk so
 * long-running agents can recover from mid-flight auth changes.
 *
 * ## The problem this solves
 *
 * The spawn pipeline injects `AGENT_HUB_API_KEY` at the moment `spawn()`
 * runs. The child's process env is captured once and never refreshed.
 * If `/api/auth/setup` is called against a server that previously had no
 * auth, the gate flips from "open → Owner without creds" to "JWT/apiKey
 * required" — but every in-flight session is still running with the
 * empty env it inherited at spawn time. Tool calls start returning 401
 * mid-turn with no recovery path other than a full session restart.
 *
 * ## How the file fixes it
 *
 * The server writes a per-session token to
 * `<dataDir>/spawn-creds/<sessionId>.token`. The agent-side shell
 * helpers (`ah-api.sh:ah_resolve_key`) consult this file fresh on every
 * invocation as a fallback when `AGENT_HUB_API_KEY` is unset. That makes
 * the credential a runtime lookup instead of a frozen env capture, so
 * the next tool call after the file is written succeeds.
 *
 * Trigger points (W1):
 *   - `/api/auth/setup` writes a freshly-minted `ahub_*` token for every
 *     session active in the last 24 h (the full set — no owner filter,
 *     because setup runs only when the server has zero auth and any
 *     recent session needs recovery regardless of owner_user_id).
 *   - Future spawns should also write here (W2 follow-up).
 *
 * ## Security
 *
 * - File is written with mode 0600. The agent process runs as the same
 *   OS user as the server, so the agent can read its own session's
 *   creds; nobody else on the host can.
 * - The directory is created with mode 0700 for the same reason.
 * - Session id is validated against a strict charset before being used
 *   as a path segment — defence-in-depth against accidental directory
 *   traversal even though callers come from inside the server.
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

const SUBDIR = 'spawn-creds';
/** UUIDs and the test-friendly slug variants we accept as session ids. */
const SESSION_ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(`spawn-creds-file: invalid sessionId ${JSON.stringify(sessionId)}`);
  }
}

/** Directory that holds all `<sessionId>.token` files for a given data dir. */
export function spawnCredsDir(dataDir: string): string {
  return path.join(dataDir, SUBDIR);
}

/** Absolute path of the spawn-creds file for one session. */
export function spawnCredsPath(sessionId: string, dataDir: string): string {
  assertSafeSessionId(sessionId);
  return path.join(spawnCredsDir(dataDir), `${sessionId}.token`);
}

/**
 * Write a token for `sessionId` atomically with mode 0600. Creates the
 * parent directory with mode 0700 if it doesn't exist. Overwrites any
 * pre-existing file (each call is "rotate to current creds").
 *
 * Returns the absolute path that was written so callers can log it.
 */
export function writeSpawnCredsFile(sessionId: string, token: string, dataDir: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('spawn-creds-file: token must be a non-empty string');
  }
  const dir = spawnCredsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = spawnCredsPath(sessionId, dataDir);
  // writeFileSync's `mode` only takes effect when the file is created;
  // overwriting an existing file preserves the original mode. We want
  // 0600 to be guaranteed every write, so we explicitly write a tmp
  // file with the right mode then rename. The rename is atomic on
  // POSIX, which prevents readers from ever seeing a partial token.
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600, encoding: 'utf8' });
  // Best-effort fsync-equivalent: rename overwrites the destination
  // atomically on POSIX. On Windows the rename may fail if the
  // destination exists; we'd need an unlink-then-rename dance, but
  // Agent Hub is *nix-only in practice so leave it.
  renameSync(tmp, filePath);
  return filePath;
}

/**
 * Read the token for `sessionId`, or return null when the file does
 * not exist. Throws on filesystem errors other than ENOENT so callers
 * notice corruption rather than silently treating it as "no creds".
 */
export function readSpawnCredsFile(sessionId: string, dataDir: string): string | null {
  const filePath = spawnCredsPath(sessionId, dataDir);
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete the spawn-creds file for `sessionId`. No-op if missing.
 * Used by session cleanup / future revocation paths.
 */
export function removeSpawnCredsFile(sessionId: string, dataDir: string): void {
  const filePath = spawnCredsPath(sessionId, dataDir);
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
