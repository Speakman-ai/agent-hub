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
import { sessionWorktreeIoFor } from './session-worktree-io.js';
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

/**
 * Does the session have uncommitted or unpushed work?
 *
 * Needs `sessionId`, not just a path: under a microVM env the worktree lives
 * on the guest's disk and the host directory is the boot-time seed, so a
 * host-side `git status` would call an active session clean and the
 * "changes ready" indicator would never fire.
 */
export async function isWorktreeDirty(
  sessionId: string,
  worktreePath: string,
  deps: CodeChangeTrackerDeps,
): Promise<boolean> {
  const checkDirty =
    deps.checkDirty ??
    (async (cwd: string) => {
      const changes = await checkWorktreeChanges(await sessionWorktreeIoFor(sessionId, cwd));
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
    dirty = await isWorktreeDirty(sessionId, worktreePath, deps);
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
  /** Test hook. Production uses a timer that does not keep the process alive. */
  schedule?: (fn: () => void, ms: number) => void;
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
 * Wait until a burst of writes settles before reloading the iframe, so the
 * dev server has the new files compiled and a multi-file edit reloads once.
 */
export const PREVIEW_REFRESH_AFTER_WRITE_MS = 800;

const pendingMutatingBySession = new Map<string, Set<string>>();
/**
 * Token of the write-refresh each session is waiting on. Tokens come from one
 * counter and are never reused, so a timer whose schedule was flushed or
 * superseded can never match a later schedule for the same session.
 */
const refreshTokenBySession = new Map<string, number>();
let nextRefreshToken = 0;

function defaultRefreshSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
}

/**
 * Remember a tool call that may write files. The call is recorded when it
 * starts; the preview reload waits for its result, because `tool_use` fires
 * before the write and a git check at that moment still sees a clean tree.
 */
export function noteMutatingToolUse(
  sessionId: string,
  toolUseId: string | undefined,
  tool: string,
  input: Record<string, unknown>,
): void {
  if (!toolUseId || !isMutatingToolUse(tool, input)) return;
  let pending = pendingMutatingBySession.get(sessionId);
  if (!pending) {
    pending = new Set();
    pendingMutatingBySession.set(sessionId, pending);
  }
  pending.add(toolUseId);
}

/**
 * A remembered write just finished. Reload the preview after a short quiet
 * period. Git status is not consulted: parallel tool calls all start before
 * any write lands, so a cleanliness check at `tool_use` time skips the reload
 * for the whole turn.
 */
export function refreshPreviewAfterMutatingToolResult(
  sessionId: string,
  toolUseId: string,
  isError: boolean,
  deps: CodeChangePreviewSyncDeps,
): void {
  const pending = pendingMutatingBySession.get(sessionId);
  if (!pending?.delete(toolUseId)) return;
  if (pending.size === 0) pendingMutatingBySession.delete(sessionId);
  if (isError) return;
  void markCodeChangedIfDirty(sessionId, deps.worktreePath, deps);
  schedulePreviewRefreshAfterWrite(sessionId, deps);
}

/** Drop tool calls whose results never arrived (killed turn). */
export function clearMutatingToolUses(sessionId: string): void {
  pendingMutatingBySession.delete(sessionId);
}

function schedulePreviewRefreshAfterWrite(
  sessionId: string,
  deps: CodeChangePreviewSyncDeps,
): void {
  nextRefreshToken += 1;
  const token = nextRefreshToken;
  refreshTokenBySession.set(sessionId, token);
  const schedule = deps.schedule ?? defaultRefreshSchedule;
  schedule(() => {
    if (refreshTokenBySession.get(sessionId) !== token) return;
    refreshTokenBySession.delete(sessionId);
    broadcastPreviewRefreshIfReady(sessionId, deps, {
      force: true,
      reason: 'Files changed during turn',
    });
  }, PREVIEW_REFRESH_AFTER_WRITE_MS);
}

/**
 * The turn ended while a write-refresh was still waiting out its quiet
 * period. Reload now instead of holding the iframe for the rest of the
 * debounce. Returns false when nothing was waiting.
 */
export function flushScheduledPreviewRefresh(
  sessionId: string,
  deps: PreviewWorktreeSyncDeps,
): boolean {
  if (!refreshTokenBySession.has(sessionId)) return false;
  refreshTokenBySession.delete(sessionId);
  broadcastPreviewRefreshIfReady(sessionId, deps, {
    force: true,
    reason: 'Turn finished — reloading preview',
  });
  return true;
}

/**
 * Turn-end hot reload: reload the preview iframe when the worktree is dirty.
 * Callers should not also require `code_changed_at` — that flag is set from
 * the same git check, which misses a turn whose writes all started together.
 */
export async function syncPreviewAfterWorktreeTurnIfDirty(
  sessionId: string,
  worktreePath: string,
  deps: CodeChangePreviewSyncDeps,
): Promise<void> {
  if (!(await isWorktreeDirty(sessionId, worktreePath, deps))) return;
  broadcastPreviewRefreshIfReady(sessionId, deps, {
    force: true,
    reason: 'Turn finished — reloading preview',
  });
}

/**
 * Fire-and-forget hook from chat stream `tool_use` events.
 *
 * Marks the session when git already sees the edit. Does not reload the
 * preview: this event arrives before the write, and a reload here shows the
 * previous page. The reload is `refreshPreviewAfterMutatingToolResult`.
 */
export function handleMutatingToolUseForCodeChange(
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
  deps: CodeChangePreviewSyncDeps,
): void {
  if (!isMutatingToolUse(tool, input)) return;
  void markCodeChangedIfDirty(sessionId, deps.worktreePath, deps);
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
    const changes = await checkWorktreeChanges(await sessionWorktreeIoFor(sessionId, worktreePath));
    return !changes.hasUncommitted && !changes.hasUnpushed;
  } catch {
    return false;
  }
}

/** Card-assignment / autonomous sessions: auto-ship only when git still has work to publish. */
export async function shouldTriggerAutoShipAtSessionEnd(
  sessionId: string,
  worktreePath: string,
  _stmts: Pick<Stmts, 'getSession'>,
): Promise<boolean> {
  try {
    const changes = await checkWorktreeChanges(await sessionWorktreeIoFor(sessionId, worktreePath));
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
