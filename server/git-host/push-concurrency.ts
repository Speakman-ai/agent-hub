/**
 * GitHub-Actions-style concurrency for work a branch push retriggers (push CI
 * and the PR auto-review). Each branch is its own concurrency group:
 *
 *   - `queue` (default, like GHA without `cancel-in-progress`): the running
 *     job finishes; a newer push waits behind it, and a still-pending older
 *     push is dropped so only the newest head runs next.
 *   - `cancel` (GHA `cancel-in-progress: true`): a newer push stops the
 *     running job and starts on the new head right away.
 *
 * Configured per project via `Project.pushConcurrency`, separately for CI and
 * review because a reviewer turn is far more expensive than a CI run.
 */
import type { Project, PushConcurrencyMode } from '../types.js';

export const PUSH_CONCURRENCY_MODES: readonly PushConcurrencyMode[] = ['queue', 'cancel'];

export function isPushConcurrencyMode(value: unknown): value is PushConcurrencyMode {
  return (PUSH_CONCURRENCY_MODES as readonly unknown[]).includes(value);
}

export function resolvePushConcurrency(
  project: Pick<Project, 'pushConcurrency'>,
  kind: 'ci' | 'review',
): PushConcurrencyMode {
  const raw = project.pushConcurrency?.[kind];
  return isPushConcurrencyMode(raw) ? raw : 'queue';
}
