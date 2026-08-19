/**
 * Dev-server build step.
 *
 * `prEnv.devServer.buildCommand` names an optional command that runs to
 * completion **before** `startCommand`, after apt packages install. It exists
 * so a project can separate the expensive, code-change-driven work (`npm ci`,
 * `docker compose build`, a compile pass) from the cheap long-lived server
 * process. The Hub can then restart the server (re-run `startCommand`) without
 * repeating the build — the "Restart Server" action skips this step, "Rebuild
 * App" runs it.
 *
 * Runs inside the session's SessionEnv with the same non-secret env + resolved
 * secrets the dev server itself gets, so a build that reads registry/proxy
 * credentials works. A non-zero exit fails the start: the project declared the
 * build a hard prerequisite of the server.
 */

import type { SessionEnv, SessionEnvExit } from '../session-env/session-env.js';
import { waitForEnvProcessExit } from './env-process-exit.js';

/** Stream label used for build log lines in the preview log tail. */
export const BUILD_PROCESS_NAME = 'build';

export interface RunDevServerBuildOpts {
  env: SessionEnv;
  /** Shell command run via `sh -c`. Already trimmed/validated upstream. */
  buildCommand: string;
  /** Working directory relative to the worktree root (matches `startCommand`). */
  cwd?: string;
  /** Same env + resolved secrets the dev server gets. */
  spawnEnv?: Record<string, string>;
  /** Per-line sink so callers can tee build output into the preview log tail. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunDevServerBuildResult {
  exit: SessionEnvExit;
}

/**
 * Run `buildCommand` to completion in `env` and resolve with its exit. Never
 * throws for a non-zero exit — the caller decides whether that fails the start
 * (it does) so it can roll back the reserved ports and env first.
 */
export async function runDevServerBuild(
  opts: RunDevServerBuildOpts,
): Promise<RunDevServerBuildResult> {
  opts.onLine?.(`[${BUILD_PROCESS_NAME}] running: ${opts.buildCommand}`, 'stdout');
  const proc = opts.env.spawn(opts.buildCommand, {
    cwd: opts.cwd,
    env: opts.spawnEnv,
    name: `dev-server-build:${opts.env.sessionId}`,
  });
  const exit = await waitForEnvProcessExit(proc, opts.onLine);
  return { exit };
}

/** Human-readable summary of a non-zero / errored build exit for error messages. */
export function describeBuildExit(exit: SessionEnvExit): string {
  if (exit.error) return `buildCommand failed to spawn: ${exit.error.message}`;
  if (exit.signal) return `buildCommand killed by signal ${exit.signal}`;
  return `buildCommand exited with code ${exit.code ?? 'unknown'}`;
}
