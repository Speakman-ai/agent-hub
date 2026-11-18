/**
 * Per-project pre-push hook for the Finalize GitHub push path.
 *
 * An Admin configures a shell command on the project (`Project.prePushHook`).
 * Finalize runs it in the checkout it is about to push, after the push-target
 * lock and before `git push`, with the same GitHub token the push uses. The
 * hook can:
 *
 *   - rename the checked-out branch (`git branch -m`); Finalize pushes and
 *     opens the PR on the new name,
 *   - append text to the PR body by writing to `$AGENT_HUB_PR_BODY_APPEND`
 *     (e.g. `Fixes #123`),
 *   - fail the push by exiting non-zero.
 *
 * It must not change HEAD: review and checks validated one commit, and that
 * commit is the only one Finalize will push.
 *
 * Agent Hub-hosted projects (`gitHost: 'agenthub'`) never run the hook.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '../types.js';
import { spawn } from 'node:child_process';
import { MAX_BUFFER, execGit } from './branch-facts.js';

export const PRE_PUSH_HOOK_DEFAULT_TIMEOUT_SEC = 300;
export const PRE_PUSH_HOOK_MAX_TIMEOUT_SEC = 1800;
export const PRE_PUSH_HOOK_MAX_COMMAND_LENGTH = 20_000;
const PR_BODY_APPEND_MAX = 20_000;
const OUTPUT_TAIL_CHARS = 2_000;
/** Output kept in memory per stream while the hook runs. */
const OUTPUT_KEEP = 64 * 1024;

export interface ResolvedPrePushHook {
  command: string;
  timeoutMs: number;
}

/** The hook to run for this project's push, or null when none applies. */
export function resolvePrePushHook(
  project: Pick<Project, 'gitHost' | 'prePushHook'>,
): ResolvedPrePushHook | null {
  if (project.gitHost === 'agenthub') return null;
  const hook = project.prePushHook;
  if (!hook || hook.enabled !== true) return null;
  const command = hook.command?.trim();
  if (!command) return null;
  const sec =
    typeof hook.timeoutSec === 'number' && Number.isFinite(hook.timeoutSec) && hook.timeoutSec > 0
      ? Math.min(Math.floor(hook.timeoutSec), PRE_PUSH_HOOK_MAX_TIMEOUT_SEC)
      : PRE_PUSH_HOOK_DEFAULT_TIMEOUT_SEC;
  return { command, timeoutMs: sec * 1000 };
}

export interface PrePushHookContext {
  sessionId?: string | null;
  cardId?: string | null;
  cardTitle?: string | null;
  githubRepo?: string | null;
  /** Open PR already on the branch, so the hook can skip one-time steps. */
  existingPrUrl?: string | null;
}

export interface RunPrePushHookArgs {
  hook: ResolvedPrePushHook;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  env: NodeJS.ProcessEnv | undefined;
  context: PrePushHookContext;
}

export interface PrePushHookResult {
  /** Branch checked out after the hook ran; differs from the input on a rename. */
  branch: string;
  /** Text the hook asked to add to the PR body, trimmed; empty when none. */
  prBodyAppend: string;
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > OUTPUT_TAIL_CHARS ? `...${t.slice(-OUTPUT_TAIL_CHARS)}` : t;
}

async function gitOut(worktreePath: string, argv: string[], env: NodeJS.ProcessEnv | undefined) {
  const { stdout } = await execGit('git', argv, {
    cwd: worktreePath,
    env,
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

/**
 * A hook run that must not be pushed. `branch` is the branch the checkout is
 * on afterwards (null when unknown or detached), so callers can record a
 * rename that happened before the failure.
 */
export class PrePushHookError extends Error {
  constructor(
    message: string,
    readonly branch: string | null,
  ) {
    super(message);
    this.name = 'PrePushHookError';
  }
}

/** Everything observed about one hook run; {@link hookFailureReason} judges it. */
export interface HookOutcome {
  /** bash's exit code; null when it died from a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /**
   * The deadline fired. Wins over any exit code: bash can exit 0 while a
   * background child it started keeps running until it is killed.
   */
  timedOut: boolean;
  timeoutMs: number;
  /** bash could not be started at all. */
  spawnError: string | null;
  stdout: string;
  stderr: string;
}

/**
 * The single success rule for a hook run: it started, finished before the
 * deadline, and exited 0. Returns null on success, else the reason followed by
 * the tail of stdout and stderr.
 */
export function hookFailureReason(o: HookOutcome): string | null {
  let reason: string | null;
  if (o.timedOut) reason = `timed out after ${Math.ceil(o.timeoutMs / 1000)}s`;
  else if (o.spawnError) reason = `could not start: ${o.spawnError}`;
  else if (o.code === 0) reason = null;
  else if (typeof o.code === 'number') reason = `exit ${o.code}`;
  else if (o.signal) reason = `killed by ${o.signal}`;
  else reason = 'ended without an exit code';
  if (reason === null) return null;
  const output = [o.stdout, o.stderr]
    .map((v) => v.trim())
    .filter(Boolean)
    .join('\n');
  return output ? `${reason}:\n${tail(output)}` : reason;
}

/**
 * Run the hook until bash and everything holding its output have finished,
 * or the deadline fires. Records what happened; never decides success.
 */
function execHook(
  hook: ResolvedPrePushHook,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HookOutcome> {
  return new Promise<HookOutcome>((resolve) => {
    const outcome: HookOutcome = {
      code: null,
      signal: null,
      timedOut: false,
      timeoutMs: hook.timeoutMs,
      spawnError: null,
      stdout: '',
      stderr: '',
    };
    const keep = (prev: string, chunk: Buffer) => (prev + chunk.toString()).slice(-OUTPUT_KEEP);
    // Own process group (`detached`), so a timeout also stops whatever the
    // hook started (gh, curl, sleep), not just bash. execFile ignores
    // `detached`, hence spawn.
    const child = spawn('bash', ['-c', hook.command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (c: Buffer) => (outcome.stdout = keep(outcome.stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (outcome.stderr = keep(outcome.stderr, c)));
    let done = false;
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, hook.timeoutMs);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.on('error', (e) => {
      outcome.spawnError = e.message;
      finish();
    });
    // `close` waits for stdout/stderr to close as well, so a background child
    // still holding them keeps the run open until it exits or is killed.
    child.on('close', (code, signal) => {
      outcome.code = code;
      outcome.signal = signal;
      finish();
    });
  });
}

export async function runPrePushHook(args: RunPrePushHookArgs): Promise<PrePushHookResult> {
  const { hook, worktreePath, env, context } = args;
  const scratch = await mkdtemp(path.join(tmpdir(), 'agent-hub-pre-push-'));
  const appendFile = path.join(scratch, 'pr-body-append.md');
  try {
    const hookEnv: NodeJS.ProcessEnv = {
      ...(env ?? process.env),
      AGENT_HUB_BRANCH: args.branch,
      AGENT_HUB_BASE_BRANCH: args.baseBranch,
      AGENT_HUB_HEAD_SHA: args.headSha,
      AGENT_HUB_SESSION_ID: context.sessionId ?? '',
      AGENT_HUB_CARD_ID: context.cardId ?? '',
      AGENT_HUB_CARD_TITLE: context.cardTitle ?? '',
      AGENT_HUB_GITHUB_REPO: context.githubRepo ?? '',
      AGENT_HUB_EXISTING_PR_URL: context.existingPrUrl ?? '',
      AGENT_HUB_PR_BODY_APPEND: appendFile,
    };
    const failure = hookFailureReason(await execHook(hook, worktreePath, hookEnv));

    // Read the branch even when the hook failed: a hook that renamed the
    // branch and then exited non-zero has still moved the checkout, and the
    // session must follow it.
    let branch: string | null = null;
    try {
      const current = await gitOut(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
      branch = current && current !== 'HEAD' ? current : null;
    } catch {
      branch = null;
    }
    if (failure) {
      throw new PrePushHookError(`pre-push hook failed: ${failure}`, branch);
    }
    if (!branch) {
      throw new PrePushHookError(
        'pre-push hook left the checkout on a detached HEAD; nothing to push',
        null,
      );
    }
    const head = await gitOut(worktreePath, ['rev-parse', 'HEAD'], env);
    if (head !== args.headSha) {
      throw new PrePushHookError(
        `pre-push hook moved HEAD from ${args.headSha.slice(0, 12)} to ${head.slice(0, 12)}; ` +
          'Finalize only pushes the commit that passed review and checks',
        branch,
      );
    }

    let prBodyAppend = '';
    try {
      prBodyAppend = (await readFile(appendFile, 'utf8')).trim().slice(0, PR_BODY_APPEND_MAX);
    } catch {
      /* the hook wrote nothing */
    }
    return { branch, prBodyAppend };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export type PrePushHookPatch =
  | { ok: true; value: NonNullable<Project['prePushHook']> | null }
  | { ok: false; error: string };

/** Validate a `prePushHook` PATCH value. `null` clears the setting. */
export function parsePrePushHookPatch(raw: unknown): PrePushHookPatch {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'prePushHook must be an object or null' };
  }
  const { enabled, command, timeoutSec } = raw as Record<string, unknown>;
  const value: NonNullable<Project['prePushHook']> = {};
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'prePushHook.enabled must be a boolean' };
    }
    value.enabled = enabled;
  }
  if (command !== undefined) {
    if (typeof command !== 'string') {
      return { ok: false, error: 'prePushHook.command must be a string' };
    }
    if (command.length > PRE_PUSH_HOOK_MAX_COMMAND_LENGTH) {
      return {
        ok: false,
        error: `prePushHook.command must be at most ${PRE_PUSH_HOOK_MAX_COMMAND_LENGTH} characters`,
      };
    }
    value.command = command;
  }
  if (timeoutSec !== undefined) {
    if (
      typeof timeoutSec !== 'number' ||
      !Number.isInteger(timeoutSec) ||
      timeoutSec < 1 ||
      timeoutSec > PRE_PUSH_HOOK_MAX_TIMEOUT_SEC
    ) {
      return {
        ok: false,
        error: `prePushHook.timeoutSec must be an integer from 1 to ${PRE_PUSH_HOOK_MAX_TIMEOUT_SEC}`,
      };
    }
    value.timeoutSec = timeoutSec;
  }
  return { ok: true, value };
}
