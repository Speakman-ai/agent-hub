/**
 * Session-scoped worktree mutation tracking.
 *
 * `sessions.code_changed_at` is set on the first detected dirty
 * worktree during a chat turn (via mutating tool_use events). It drives:
 *   - `code_changed` WS broadcast (UI can surface a preview chip)
 *   - optional iframe refresh when a user-started preview is already `ready`
 *   - ad-hoc auto-git short-circuit when the flag is still NULL and
 *     `git status --porcelain` is clean (suppresses misfired PR toasts)
 *
 * The worktree remains ground truth — the column is a cheap cache.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BroadcastFn, Project, Stmts } from './types.js';
import { checkWorktreeChanges } from './auto-git.js';
import {
  broadcastPreviewRefreshIfReady,
  type PreviewWorktreeSyncDeps,
} from './preview/preview-worktree-sync.js';

const execFileAsync = promisify(execFile);

/** Tools that may mutate files on disk (best-effort; Bash needs a command scan). */
const MUTATING_FILE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'StrReplace',
  'ApplyPatch',
  'file_change',
]);

/** Bash subcommands that usually imply filesystem writes. */
const BASH_MUTATION_RE =
  /(?:^|[\s;&|])(?:tee\b|sed\s+-i|git\s+(?:add|commit|checkout|merge|rebase|am)|npm\s+(?:install|ci|run)|npx\b[^|]*\b(?:write|patch)|install\b|cp\b|mv\b|rm\b|mkdir\b|touch\b|truncate\b|cat\s*>|>>|>\s*[^\s&|])/;

export function isMutatingToolUse(tool: string, input: Record<string, unknown> = {}): boolean {
  if (MUTATING_FILE_TOOLS.has(tool)) return true;
  if (tool === 'Bash' || tool === 'Shell' || tool === 'run_terminal_cmd') {
    const cmd =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.cmd === 'string' && input.cmd) ||
      '';
    if (!cmd.trim()) return false;
    return BASH_MUTATION_RE.test(cmd);
  }
  if (input.changes && Array.isArray(input.changes) && input.changes.length > 0) {
    return true;
  }
  return false;
}

export interface MarkCodeChangedResult {
  /** First transition NULL → timestamp in this session. */
  newlyMarked: boolean;
  codeChangedAt: string | null;
}

export interface CodeChangeTrackerDeps {
  stmts: Pick<Stmts, 'getSession' | 'updateSessionCodeChangedAt'>;
  broadcast: BroadcastFn;
  now?: () => Date;
  checkDirty?: (cwd: string) => Promise<boolean>;
}

export async function isWorktreeDirty(
  worktreePath: string,
  deps: CodeChangeTrackerDeps,
): Promise<boolean> {
  const checkDirty =
    deps.checkDirty ??
    (async (cwd: string) => {
      const changes = await checkWorktreeChanges(cwd);
      return changes.hasUncommitted || changes.hasUnpushed;
    });
  try {
    return await checkDirty(worktreePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[code-change] git status failed: ${msg}`);
    return false;
  }
}

export async function markCodeChangedIfDirty(
  sessionId: string,
  worktreePath: string,
  deps: CodeChangeTrackerDeps,
): Promise<MarkCodeChangedResult> {
  const row = deps.stmts.getSession.get(sessionId) as { code_changed_at?: string | null };
  if (row?.code_changed_at) {
    return { newlyMarked: false, codeChangedAt: row.code_changed_at };
  }

  let dirty = false;
  try {
    dirty = await isWorktreeDirty(worktreePath, deps);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[code-change] git status failed for ${sessionId.slice(0, 8)}: ${msg}`);
    return { newlyMarked: false, codeChangedAt: null };
  }

  if (!dirty) {
    return { newlyMarked: false, codeChangedAt: null };
  }

  const at = (deps.now ?? (() => new Date()))().toISOString();
  try {
    deps.stmts.updateSessionCodeChangedAt.run(at, sessionId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[code-change] failed to persist code_changed_at: ${msg}`);
    return { newlyMarked: false, codeChangedAt: null };
  }

  try {
    deps.broadcast({
      type: 'code_changed',
      sessionId,
      codeChangedAt: at,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[code-change] broadcast failed: ${msg}`);
  }

  return { newlyMarked: true, codeChangedAt: at };
}

export interface CodeChangePreviewSyncDeps extends CodeChangeTrackerDeps, PreviewWorktreeSyncDeps {
  project: Project;
  worktreePath: string;
}

/**
 * @deprecated Preview boot is user-only (toolbar / POST …/preview/start).
 * Kept as a no-op so callers do not need a flag day; `autoStart` in project
 * config is ignored.
 */
export function maybeAutoStartPreviewOnCodeChange(
  _sessionId: string,
  _markResult: MarkCodeChangedResult,
  _deps: CodeChangePreviewSyncDeps,
): void {
  /* intentionally empty */
}

/**
 * Turn-end hot reload: reload the preview iframe when this session recorded
 * a code change during the turn (caller gates on `code_changed_at`).
 */
export async function syncPreviewAfterWorktreeTurnIfDirty(
  sessionId: string,
  worktreePath: string,
  deps: CodeChangePreviewSyncDeps,
): Promise<void> {
  if (!(await isWorktreeDirty(worktreePath, deps))) return;
  broadcastPreviewRefreshIfReady(sessionId, deps, {
    force: true,
    reason: 'Turn finished — reloading preview',
  });
}

/**
 * Fire-and-forget hook from chat stream `tool_use` events.
 */
export function handleMutatingToolUseForCodeChange(
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
  deps: CodeChangePreviewSyncDeps,
): void {
  if (!isMutatingToolUse(tool, input)) return;
  void (async () => {
    const row = deps.stmts.getSession.get(sessionId) as { code_changed_at?: string | null };
    if (!row?.code_changed_at) {
      const mark = await markCodeChangedIfDirty(sessionId, deps.worktreePath, deps);
      if (!mark.newlyMarked && !mark.codeChangedAt) return;
    }
    broadcastPreviewRefreshIfReady(sessionId, deps, {
      reason: 'Files changed during turn',
    });
  })();
}

/**
 * Returns true when the session never recorded a code change and the
 * worktree is clean — safe to skip ad-hoc PR / changes_ready work.
 */
export async function sessionHasNoPublishableWork(
  sessionId: string,
  worktreePath: string,
  stmts: Pick<Stmts, 'getSession'>,
): Promise<boolean> {
  try {
    const row = stmts.getSession.get(sessionId) as { code_changed_at?: string | null };
    if (row?.code_changed_at) return false;
  } catch {
    // Missing stmt in tests or legacy wiring — fall through to git probe.
  }
  try {
    const changes = await checkWorktreeChanges(worktreePath);
    return !changes.hasUncommitted && !changes.hasUnpushed;
  } catch {
    return false;
  }
}

/** Card-assignment / autonomous sessions: auto-ship only when git still has work to publish. */
export async function shouldTriggerAutoShipAtSessionEnd(
  _sessionId: string,
  worktreePath: string,
  _stmts: Pick<Stmts, 'getSession'>,
): Promise<boolean> {
  try {
    const changes = await checkWorktreeChanges(worktreePath);
    return changes.hasUncommitted || changes.hasUnpushed;
  } catch {
    return false;
  }
}

/** Lightweight porcelain probe (used by tests and optional backstop). */
export async function worktreeHasPorcelainChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}
