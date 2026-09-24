import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { worktreeHasFinalizeCi } from './worktree-has-ci.js';

const GUARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spawn-guards');

function resolveRealBinary(binaryName: string, pathEnv: string, skipDir: string): string {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || dir === skipDir) continue;
    const candidate = path.join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return binaryName;
}

/**
 * Install the PATH-shimmed `git` / `gh` wrappers for a spawned session
 * agent. The `git` shim enforces two things (see `spawn-guards/git`):
 *
 *   1. **One-session-one-branch invariant** — blocks `git checkout -b`,
 *      `git switch -c`, and `git branch <new>` inside the worktree. This
 *      applies to ANY worktree-backed session, regardless of whether the
 *      project has `.agent-hub/ci.yaml`: every session worktree is created
 *      on a single dedicated branch (`server/worktree.ts`) that the session
 *      record, Finalize, `changes_ready`, and push all key off. A second
 *      branch silently strands the agent's commits. Operator override:
 *      `AGENT_HUB_ALLOW_BRANCH_OPS=1`.
 *   2. **Direct-ship gate**: applies to every session, including sessions
 *      without a worktree or CI config. Platform shipping uses its own env.
 */
export function applySessionGitGuards(
  env: NodeJS.ProcessEnv,
  worktreePath: string | null | undefined,
): void {
  const pathBefore = env.PATH ?? process.env.PATH ?? '';
  env.AGENT_HUB_REAL_GIT = resolveRealBinary('git', pathBefore, GUARD_DIR);
  env.AGENT_HUB_REAL_GH = resolveRealBinary('gh', pathBefore, GUARD_DIR);
  // (1) Branch protection: active for every worktree-backed session.
  if (worktreePath) env.AGENT_HUB_PROTECT_SESSION_BRANCH = '1';
  if (worktreeHasFinalizeCi(worktreePath)) {
    env.AGENT_HUB_FINALIZE_CI_CONFIGURED = '1';
  }
  env.PATH = `${GUARD_DIR}${path.delimiter}${pathBefore}`;
}
