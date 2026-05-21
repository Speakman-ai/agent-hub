/**
 * Persistent host (operator) CLI HOME under the Hub data directory.
 *
 * Global Cursor OAuth (`/api/config/cursor-auth`) and global Codex ChatGPT
 * device login (`/api/config/codex-auth`) write caches under the operator
 * HOME. Host-wide spawns without a `userId` read the same tree. On Docker
 * only `/data` survives container recreate — process `os.homedir()` is
 * ephemeral. Pinning caches to `<dataDir>/host-creds/home` keeps operator
 * login state across instance restarts when the data volume is mounted.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

const ROOT_SUBDIR = 'host-creds';
const HOME_SUBDIR = 'home';

/** Directory that holds the operator's persistent CLI HOME tree. */
export function hostCliHomePath(dataDir: string): string {
  return path.join(dataDir, ROOT_SUBDIR, HOME_SUBDIR);
}

/** Codex CLI cache for the operator — `$HOME/.codex` under the persistent host HOME. */
export function hostCodexHomePath(dataDir: string): string {
  return path.join(hostCliHomePath(dataDir), '.codex');
}

/**
 * Resolve which Codex home directory to probe, matching `buildSpawnEnv`:
 * explicit `CODEX_HOME` → `<HOME>/.codex` → persistent host tree.
 */
export function resolveCodexHomeForProbe(
  env: NodeJS.ProcessEnv | undefined,
  dataDir: string,
): string {
  if (env?.CODEX_HOME && String(env.CODEX_HOME).trim()) return String(env.CODEX_HOME);
  if (env?.HOME && String(env.HOME).trim()) return path.join(String(env.HOME), '.codex');
  return hostCodexHomePath(dataDir);
}

function operatorCursorCachePath(): string | null {
  const src = path.join(os.homedir(), '.cursor');
  if (!existsSync(src)) return null;
  try {
    if (readdirSync(src).length === 0) return null;
  } catch {
    return null;
  }
  return src;
}

/**
 * One-time best-effort copy of the operator's existing `~/.cursor` cache into
 * the persistent host HOME when the destination has no cache yet. Lets
 * upgrades keep working auth without forcing a re-login.
 */
function operatorCodexCachePath(): string | null {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    try {
      if (readdirSync(fromEnv).length > 0) return fromEnv;
    } catch {
      return null;
    }
  }
  const src = path.join(os.homedir(), '.codex');
  if (!existsSync(src)) return null;
  try {
    if (readdirSync(src).length === 0) return null;
  } catch {
    return null;
  }
  return src;
}

function migrateOperatorCodexCacheIfNeeded(hostHome: string): void {
  const dest = path.join(hostHome, '.codex');
  if (existsSync(dest)) {
    try {
      if (readdirSync(dest).length > 0) return;
    } catch {
      return;
    }
  }
  const src = operatorCodexCachePath();
  if (!src) return;
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    /* non-fatal */
  }
}

function migrateOperatorCursorCacheIfNeeded(hostHome: string): void {
  const dest = path.join(hostHome, '.cursor');
  if (existsSync(dest)) {
    try {
      if (readdirSync(dest).length > 0) return;
    } catch {
      return;
    }
  }
  const src = operatorCursorCachePath();
  if (!src) return;
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    /* non-fatal — operator can re-login via Settings */
  }
}

/**
 * Create the persistent host HOME (mode 0700), verify the running process
 * owns it, and migrate legacy operator `~/.cursor` / `~/.codex` when
 * present. Returns the absolute path.
 *
 * Ownership guard: on Docker, the data volume may have been populated by a
 * prior container running under a different UID. If the leaf already
 * exists and is owned by another UID, this throws rather than handing a
 * misowned cache to a CLI spawn. Mirrors `ensurePerUserCliHome`'s guard so
 * the host tree gets the same security properties as the per-user tree.
 * `geteuid` is undefined on Windows; the check skips cleanly there.
 */
export function ensureHostCliHome(dataDir: string): string {
  const home = hostCliHomePath(dataDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  } catch {
    /* already exists */
  }

  const geteuid = (process as NodeJS.Process & { geteuid?: () => number }).geteuid?.bind(process);
  if (typeof geteuid === 'function') {
    const myUid = geteuid();
    let stats;
    try {
      stats = statSync(home);
    } catch (err) {
      throw new Error(
        `host-cli-home: failed to stat ${home} after mkdir: ${(err as Error).message}`,
      );
    }
    if (typeof stats.uid === 'number' && stats.uid !== myUid) {
      throw new Error(
        `host-cli-home: refusing to use ${home} — owned by uid ${stats.uid} (expected ${myUid})`,
      );
    }
  }

  migrateOperatorCursorCacheIfNeeded(home);
  migrateOperatorCodexCacheIfNeeded(home);
  return home;
}
