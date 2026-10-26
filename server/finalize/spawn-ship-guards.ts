import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { worktreeHasFinalizeCi } from './worktree-has-ci.js';
import { NO_GUARDRAILS_ENV } from '../no-guardrails.js';

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
 *      Skipped only when `opts.noGuardrails` is set, i.e. the session is in
 *      No Guardrails mode on a project that allows it.
 */
export function applySessionGitGuards(
  env: NodeJS.ProcessEnv,
  worktreePath: string | null | undefined,
  opts: { noGuardrails?: boolean } = {},
): void {
  const pathBefore = env.PATH ?? process.env.PATH ?? '';
  env.AGENT_HUB_REAL_GIT = resolveRealBinary('git', pathBefore, GUARD_DIR);
  env.AGENT_HUB_REAL_GH = resolveRealBinary('gh', pathBefore, GUARD_DIR);
  // (1) Branch protection: active for every worktree-backed session.
  if (worktreePath) env.AGENT_HUB_PROTECT_SESSION_BRANCH = '1';
  if (worktreeHasFinalizeCi(worktreePath)) {
    env.AGENT_HUB_FINALIZE_CI_CONFIGURED = '1';
  }
  // Always written explicitly so an inherited value can never lift the gate.
  if (opts.noGuardrails) env[NO_GUARDRAILS_ENV] = '1';
  else delete env[NO_GUARDRAILS_ENV];
  env.PATH = `${GUARD_DIR}${path.delimiter}${pathBefore}`;
}
