import { existsSync, mkdirSync } from 'fs';

/**
 * Result of {@link ensureSpawnCwd}.
 *
 * `auto-created` means the directory did not exist and we created it
 * (recoverable — chat.ts logs a warning and continues).
 *
 * `failed` means the directory did not exist and could not be created
 * (chat.ts converts this into a precise error message and aborts the
 * spawn before Node can mis-report ENOENT against the binary path).
 */
export type EnsureSpawnCwdResult =
  | { status: 'exists' }
  | { status: 'auto-created' }
  | { status: 'failed'; reason: string };

/**
 * Make sure `cwd` exists before passing it to `child_process.spawn`.
 *
 * Why this exists: when a CLI is spawned with a non-existent `cwd`, Node
 * emits ENOENT against the *command*, not the directory. That historically
 * surfaced as the misleading error "binary not found at <bin>" even when the
 * binary was perfectly fine — see the dev-container scenario where the
 * ECR image has no `/home/node/projects/<slug>` directory.
 *
 * Behavior:
 *   - existsSync(cwd) → returns `{status:'exists'}`
 *   - else mkdirSync(cwd, {recursive:true}) → `{status:'auto-created'}`
 *   - mkdir failure → `{status:'failed', reason}` (caller surfaces a clear
 *     error message and skips the spawn)
 */
export function ensureSpawnCwd(cwd: string): EnsureSpawnCwdResult {
  if (existsSync(cwd)) return { status: 'exists' };
  try {
    mkdirSync(cwd, { recursive: true });
    return { status: 'auto-created' };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason };
  }
}
