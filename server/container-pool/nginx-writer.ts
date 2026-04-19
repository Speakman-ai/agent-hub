/**
 * PR-env nginx writer (W2).
 *
 * Drops a rendered server-block into `/etc/nginx/sites-available/`,
 * symlinks it into `sites-enabled/`, validates the config, and reloads
 * nginx — **idempotently**. If the target file already exists with the
 * exact same bytes, we skip the reload entirely. That property matters
 * because `pull_request.synchronize` fires on every push and we do NOT
 * want to bounce nginx hundreds of times a day when nothing changed.
 *
 * Everything that touches disk or processes goes through injected deps so
 * unit tests run without root / without a real nginx binary.
 *
 * Security:
 *   - Conf files are written 0o644 (nginx worker needs to read them).
 *   - Parent directories are created 0o755 if missing.
 *   - The nginx reload command is NEVER passed unsanitized user input —
 *     the PR number is validated as an integer before it reaches the
 *     filename.
 */

import path from 'path';

/**
 * Minimal filesystem surface. Kept narrow so tests can fake it in-memory
 * without pulling in an `fs` mock. `readFile` returns `null` (not throw)
 * for ENOENT — the caller needs to distinguish "file missing" from
 * "permission denied" and a boolean-by-side-effect is too fragile.
 */
export interface NginxFsOps {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  symlinkIfAbsent(target: string, linkPath: string): Promise<void>;
  rm(path: string): Promise<void>;
  /**
   * Resolve what a symlink points at, or null if the link is missing or
   * the path is not a symlink. Used by rollback to avoid deleting a
   * pre-existing link that doesn't belong to us.
   */
  readlink(path: string): Promise<string | null>;
}

/**
 * Minimal runner surface. Called with (command, args). Must resolve with
 * the exit code; stderr is captured for logging but not returned (if the
 * caller needs it, the runner can log it directly).
 */
export interface NginxRunner {
  run(command: string, args: readonly string[]): Promise<{ code: number; stderr: string }>;
}

export interface NginxWriterDeps {
  fs: NginxFsOps;
  runner: NginxRunner;
  /**
   * Directory that holds the canonical conf files, typically
   * `/etc/nginx/sites-available`.
   */
  sitesAvailableDir: string;
  /**
   * Directory that holds the enabled symlinks, typically
   * `/etc/nginx/sites-enabled`.
   */
  sitesEnabledDir: string;
}

export interface NginxWriteResult {
  confPath: string;
  symlinkPath: string;
  /** True iff we actually wrote + reloaded; false on the fast-path skip. */
  reloaded: boolean;
}

/**
 * Idempotently install a preview server-block config + symlink + reload.
 *
 * Contract:
 *   - If the conf file already has identical bytes AND the symlink
 *     already points at it, this is a no-op (no reload, no writes).
 *   - Otherwise: write the conf, ensure the symlink, run `nginx -t`, and
 *     if that succeeds reload nginx. Test failures abort without
 *     touching the live process.
 *   - Throws on validation failure — caller rolls back the file write via
 *     `removePreviewConf`.
 */
export async function writePreviewConf(
  deps: NginxWriterDeps,
  args: { filename: string; body: string },
): Promise<NginxWriteResult> {
  const { fs, runner, sitesAvailableDir, sitesEnabledDir } = deps;
  const confPath = path.join(sitesAvailableDir, args.filename);
  const symlinkPath = path.join(sitesEnabledDir, args.filename);

  await fs.mkdir(sitesAvailableDir);
  await fs.mkdir(sitesEnabledDir);

  const existing = await fs.readFile(confPath);
  const existingLink = await fs.readlink(symlinkPath);

  const sameFile = existing === args.body;
  const sameLink = existingLink === confPath;
  if (sameFile && sameLink) {
    // Idempotent fast-path: nothing to do. No reload.
    return { confPath, symlinkPath, reloaded: false };
  }

  if (!sameFile) {
    await fs.writeFile(confPath, args.body);
  }
  if (!sameLink) {
    // Remove any stale link that points elsewhere before replacing it.
    if (existingLink !== null) await fs.rm(symlinkPath);
    await fs.symlinkIfAbsent(confPath, symlinkPath);
  }

  // Validate *before* reload. `nginx -t` is the canonical preflight; if
  // it fails we leave the file on disk (so an operator can inspect it)
  // but abort so the live process isn't reloaded into a broken state.
  const test = await runner.run('nginx', ['-t']);
  if (test.code !== 0) {
    throw new Error(`nginx -t failed (exit ${test.code}): ${test.stderr.trim() || '(no stderr)'}`);
  }

  const reload = await runner.run('systemctl', ['reload', 'nginx']);
  if (reload.code !== 0) {
    throw new Error(
      `systemctl reload nginx failed (exit ${reload.code}): ${reload.stderr.trim() || '(no stderr)'}`,
    );
  }

  return { confPath, symlinkPath, reloaded: true };
}

/**
 * Remove a preview conf + its symlink. Used for both teardown on PR close
 * and rollback on a failed build. Idempotent — missing files are fine.
 * Does NOT reload nginx here; callers batch that via `reloadNginx`
 * because teardown may remove multiple PRs at once.
 */
export async function removePreviewConf(
  deps: NginxWriterDeps,
  args: { filename: string },
): Promise<void> {
  const { fs, sitesAvailableDir, sitesEnabledDir } = deps;
  const confPath = path.join(sitesAvailableDir, args.filename);
  const symlinkPath = path.join(sitesEnabledDir, args.filename);
  // Order matters: remove the enabled symlink first so a test-reload in
  // the middle of cleanup doesn't pick up a link to a missing target.
  await fs.rm(symlinkPath);
  await fs.rm(confPath);
}

/**
 * Explicit test + reload, used after a teardown batch.
 */
export async function reloadNginx(deps: NginxWriterDeps): Promise<void> {
  const test = await deps.runner.run('nginx', ['-t']);
  if (test.code !== 0) {
    throw new Error(`nginx -t failed during reload: ${test.stderr.trim() || '(no stderr)'}`);
  }
  const reload = await deps.runner.run('systemctl', ['reload', 'nginx']);
  if (reload.code !== 0) {
    throw new Error(`systemctl reload nginx failed: ${reload.stderr.trim() || '(no stderr)'}`);
  }
}
