import { existsSync } from 'fs';
import path from 'path';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';

/** True when the session worktree contains `.agent-hub/ci.yaml` (Finalize configured). */
export function worktreeHasFinalizeCi(worktreePath: string | null | undefined): boolean {
  if (!worktreePath) return false;
  return existsSync(path.join(worktreePath, DEFAULT_CI_CONFIG_RELATIVE_PATH));
}
