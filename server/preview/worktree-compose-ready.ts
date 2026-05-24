/**
 * Ensure a session worktree has the paths compose `build.context` needs
 * before `docker compose up --build` (avoids racing workspace clone).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const BUILD_CONTEXT_RE = /^\s*context:\s*['"]?(\.\/[^'"\s]+)/gm;

/** Relative directory names from `build.context: ./…` in a compose file. */
export function parseComposeBuildContexts(composeFileContent: string): string[] {
  const contexts = new Set<string>();
  for (const match of composeFileContent.matchAll(BUILD_CONTEXT_RE)) {
    const rel = match[1]?.replace(/^\.\//, '').trim();
    if (rel) contexts.add(rel);
  }
  return [...contexts];
}

/** Paths missing for compose build/up (empty = ready). */
export function missingWorktreeComposePaths(
  worktreeDir: string,
  composeFile: string,
  opts?: { buildContextDir?: string; composeFileDir?: string },
): string[] {
  const missing: string[] = [];
  const composeRoot = opts?.composeFileDir ?? worktreeDir;
  // Existence checks run in the Hub Node process. In Docker that process only
  // sees bind-mounted container paths (e.g. `/data/.agent-hub/workspaces/...`),
  // not macOS host paths like `/Users/...` used for `docker compose
  // --project-directory`. Prefer `composeFileDir` for build.context checks.
  const buildRoot = opts?.composeFileDir ?? opts?.buildContextDir ?? worktreeDir;
  const composePath = path.join(composeRoot, composeFile);
  if (!existsSync(composePath)) {
    missing.push(composeFile);
    return missing;
  }
  let content: string;
  try {
    content = readFileSync(composePath, 'utf8');
  } catch {
    missing.push(composeFile);
    return missing;
  }
  for (const ctx of parseComposeBuildContexts(content)) {
    if (!existsSync(path.join(buildRoot, ctx))) {
      missing.push(ctx);
    }
  }
  return missing;
}

export interface WaitForWorktreeComposeReadyOpts {
  /** Host path passed to `docker compose --project-directory`. */
  worktreeDir: string;
  composeFile: string;
  /** Container worktree path (bind-mounted clone); used to detect compose file during clone. */
  composeFileDir?: string;
  /**
   * Host path where `build.context` dirs must exist for the docker daemon.
   * Not used for `existsSync` when `composeFileDir` is set — see
   * {@link missingWorktreeComposePaths}.
   */
  buildContextDir?: string;
  /** Max time to wait for clone to materialize build contexts. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onWaiting?: (missing: string[]) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;

/**
 * Block until compose file + all `build.context` directories exist, or time out.
 * `worktreeDir` must be the host path when compose runs via docker.sock.
 */
export async function waitForWorktreeComposeReady(
  opts: WaitForWorktreeComposeReadyOpts,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  const check = () =>
    missingWorktreeComposePaths(opts.worktreeDir, opts.composeFile, {
      composeFileDir: opts.composeFileDir,
      buildContextDir: opts.buildContextDir ?? opts.worktreeDir,
    });

  while (Date.now() < deadline) {
    const missing = check();
    if (missing.length === 0) return;
    opts.onWaiting?.(missing);
    await sleep(pollIntervalMs);
  }

  const missing = check();
  if (missing.length > 0) {
    throw new Error(
      `Worktree is not ready for compose build — missing: ${missing.join(', ')}. ` +
        'Wait for session workspace provisioning to finish, then try again.',
    );
  }
}
