/**
 * Crash-safe lifecycle registry for the per-session Cursor always-apply rule
 * files that {@link ./spawn-prompt-payload.ts writeCursorHubSessionRule} writes
 * into a spawn's `.cursor/rules` directory.
 *
 * Cursor has no stdin / no per-invocation rules flag, so the *complete* Hub
 * rules must be delivered as an on-disk file in the spawn cwd (an argv element
 * would be trimmed by the kernel cap). That file is normally removed by the
 * spawn's close handler — but a server crash, SIGKILL, or a failure before the
 * handler runs would leave a git-hidden always-apply file behind that silently
 * steers *later, unrelated* Cursor sessions in that directory.
 *
 * To make the file's lifetime NOT depend on best-effort close cleanup, every
 * write is appended to a Hub-owned manifest, and the server sweeps that manifest
 * once at startup — unlinking any file a crashed process left behind. Cleanup is
 * therefore tied to a deterministic event (server startup) as well as the close
 * path, so a Hub rule can never persist across a restart.
 *
 * Kept free of `./config.js` (which opens the DB at import) so the pure spawn
 * helpers and their unit tests never pull the database in.
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  lstatSync,
} from 'fs';
import os from 'os';
import path from 'path';

const MANIFEST_BASENAME = 'cursor-session-rules.log';

/**
 * Resolve the manifest path from `AGENT_HUB_DATA_DIR` (which `config.ts` also
 * uses and exports into every spawn env), falling back to the same
 * `~/.agent-hub/data` default so writes and the startup sweep agree.
 */
function manifestPath(): string {
  const dataDir = process.env.AGENT_HUB_DATA_DIR || path.join(os.homedir(), '.agent-hub', 'data');
  return path.join(dataDir, MANIFEST_BASENAME);
}

/** Only files whose name matches this pattern are ever unlinked by the sweep. */
function isManagedRuleFile(p: string): boolean {
  const base = path.basename(p);
  return base.startsWith('agent-hub.session-') && base.endsWith('.mdc');
}

/**
 * Record an absolute Cursor rule file path so it can be swept after a crash.
 * Best-effort and append-only (no read-modify-write race); the startup sweep
 * dedupes and truncates.
 */
export function registerCursorRuleFile(absPath: string): void {
  try {
    if (!isManagedRuleFile(absPath)) return;
    const mp = manifestPath();
    mkdirSync(path.dirname(mp), { recursive: true });
    appendFileSync(mp, `${absPath}\n`, 'utf8');
  } catch {
    /* best-effort — a missing manifest only costs us the startup sweep */
  }
}

/**
 * Delete every Cursor session-rule file recorded in the manifest. Call once at
 * server startup. Never follows a symlink at the final component (unlinks the
 * link, not its target) and only touches files whose name matches the managed
 * pattern. Returns the number of files removed (for logging/tests).
 *
 * An entry is dropped from the manifest ONLY after the file is confirmed absent
 * (ENOENT) or successfully unlinked. A transient permission / filesystem /
 * sharing error (`lstat`/`rm` failing for any other reason) leaves the file in
 * place, so the entry is RETAINED and the manifest is rewritten with just the
 * unresolved entries for a later sweep — otherwise a still-present always-apply
 * rule would keep contaminating unrelated Cursor sessions with no record left
 * to clean it up.
 */
export function sweepOrphanedCursorRuleFiles(): number {
  let removed = 0;
  try {
    const mp = manifestPath();
    if (!existsSync(mp)) return 0;
    const seen = new Set<string>();
    const retained: string[] = [];
    for (const line of readFileSync(mp, 'utf8').split(/\r?\n/)) {
      const p = line.trim();
      // Foreign / malformed entries are never acted on and carry no cleanup
      // obligation, so they are simply dropped (not retained).
      if (!p || seen.has(p) || !isManagedRuleFile(p)) continue;
      seen.add(p);

      let present: boolean;
      try {
        lstatSync(p); // does not follow the final symlink
        present = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          continue; // confirmed absent (close handler already cleaned it) → drop
        }
        retained.push(p); // could not confirm absence → keep for a later sweep
        continue;
      }
      if (!present) continue;

      try {
        rmSync(p, { force: true }); // unlinks the path itself, never a symlink target
        removed++; // successful unlink → drop
      } catch {
        retained.push(p); // transient perm/fs/sharing error → keep for a later sweep
      }
    }
    // Rewrite with only the entries we could not resolve; never blindly truncate.
    writeFileSync(mp, retained.length > 0 ? `${retained.join('\n')}\n` : '', 'utf8');
  } catch {
    /* best-effort */
  }
  return removed;
}
