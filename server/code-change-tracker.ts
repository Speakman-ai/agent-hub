/**
 * Session-scoped worktree mutation tracking.
 *
 * `sessions.code_changed_at` is set on the first detected dirty
 * worktree during a chat turn (via mutating tool_use events). It drives:
 *   - `code_changed` WS broadcast (UI can surface a preview chip)
 *   - auto-preview boot when `prEnv.preview.autoStart` is enabled
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
  handlePreviewBlock,
  type PreviewHandlerDeps,
  type PreviewRuntimeLike,
} from './preview/preview-block.js';

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

export async function markCodeChangedIfDirty(
  sessionId: string,
  worktreePath: string,
  deps: CodeChangeTrackerDeps,
): Promise<MarkCodeChangedResult> {
  const row = deps.stmts.getSession.get(sessionId) as { code_changed_at?: string | null };
  if (row?.code_changed_at) {
    return { newlyMarked: false, codeChangedAt: row.code_changed_at };
  }

  const checkDirty =
    deps.checkDirty ??
    (async (cwd: string) => {
      const changes = await checkWorktreeChanges(cwd);
      return changes.hasUncommitted || changes.hasUnpushed;
    });

  let dirty = false;
  try {
    dirty = await checkDirty(worktreePath);
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

export interface AutoPreviewDeps extends CodeChangeTrackerDeps {
  runtime: PreviewRuntimeLike | null;
  project: Project;
  worktreePath: string;
  /** Preview route; defaults to `/`. */
  route?: string;
  /** Preview target; defaults to `client`. */
  target?: 'client' | 'server';
}

/**
 * When preview is enabled and `autoStart` is not explicitly false, boot
 * the worktree preview on the first code-change transition in a session.
 */
export function maybeAutoStartPreviewOnCodeChange(
  sessionId: string,
  markResult: MarkCodeChangedResult,
  deps: AutoPreviewDeps,
): void {
  if (!markResult.newlyMarked) return;

  const previewCfg = deps.project.prEnv?.preview;
  if (!previewCfg?.enabled) return;
  if (previewCfg.autoStart === false) return;
  if (!deps.runtime) return;

  const route = deps.route ?? '/';
  const target = deps.target ?? 'client';

  const handlerDeps: PreviewHandlerDeps = {
    runtime: deps.runtime,
    broadcast: deps.broadcast,
    project: deps.project,
    worktreePath: deps.worktreePath,
  };

  void handlePreviewBlock(
    sessionId,
    { target, route, reason: 'Auto-started after code change' },
    handlerDeps,
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[code-change] auto-preview failed:', msg);
  });
}

/**
 * Fire-and-forget hook from chat stream `tool_use` events.
 */
export function handleMutatingToolUseForCodeChange(
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
  deps: AutoPreviewDeps,
): void {
  if (!isMutatingToolUse(tool, input)) return;
  void (async () => {
    const mark = await markCodeChangedIfDirty(sessionId, deps.worktreePath, deps);
    maybeAutoStartPreviewOnCodeChange(sessionId, mark, deps);
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

/** Lightweight porcelain probe (used by tests and optional backstop). */
export async function worktreeHasPorcelainChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}
