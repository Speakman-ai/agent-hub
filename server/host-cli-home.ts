/**
 * Persistent host (operator) CLI HOME under the Hub data directory.
 *
 * This tree is used for host-level, non-AI-credential needs (e.g. the AWS
 * SSO cache in `project-aws-spawn.ts`) and as the inherited HOME for spawns
 * that have no owning user. It deliberately does NOT hold AI provider
 * credentials: Claude / Cursor / Codex auth is strictly per-account and lives
 * under each user's per-user HOME (`server/per-user-home.ts`). On Docker only
 * `/data` survives container recreate — process `os.homedir()` is ephemeral —
 * so pinning the tree to `<dataDir>/host-creds/home` keeps host state across
 * instance restarts when the data volume is mounted.
 */
import { mkdirSync, statSync } from 'fs';
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

/**
 * Create the persistent host HOME (mode 0700) and verify the running process
 * owns it. Returns the absolute path.
 *
 * Ownership guard: on Docker, the data volume may have been populated by a
 * prior container running under a different UID. If the leaf already exists
 * and is owned by another UID, this throws rather than handing a misowned
 * cache to a CLI spawn. Mirrors `ensurePerUserCliHome`'s guard so the host
 * tree gets the same security properties as the per-user tree. `geteuid` is
 * undefined on Windows; the check skips cleanly there.
 */
export function ensureHostCliHome(dataDir: string): string {
  const home = hostCliHomePath(dataDir);
  // `recursive: true` already creates every missing parent directory.
  mkdirSync(home, { recursive: true, mode: 0o700 });

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

  return home;
}
