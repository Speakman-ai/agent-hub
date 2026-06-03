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
 * Prepend PATH wrappers that block `git push` and `gh pr create` when the
 * Finalize ship gate disallows direct ship. No-op when the worktree has no
 * `.agent-hub/ci.yaml`.
 */
export function applyFinalizeSpawnShipGuards(
  env: NodeJS.ProcessEnv,
  worktreePath: string | null | undefined,
): void {
  if (!worktreeHasFinalizeCi(worktreePath)) return;

  const pathBefore = env.PATH ?? process.env.PATH ?? '';
  env.AGENT_HUB_REAL_GIT = resolveRealBinary('git', pathBefore, GUARD_DIR);
  env.AGENT_HUB_REAL_GH = resolveRealBinary('gh', pathBefore, GUARD_DIR);
  env.AGENT_HUB_FINALIZE_CI_CONFIGURED = '1';
  env.PATH = `${GUARD_DIR}${path.delimiter}${pathBefore}`;
}
