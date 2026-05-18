import crypto from 'crypto';
import path from 'path';
import { existsSync, statSync } from 'fs';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type {
  Stmts,
  Project,
  Agent,
  KanbanCardRow,
  KanbanEpicRow,
  AppConfig,
  BroadcastFn,
  MessageRow,
} from './types.js';
import { resolveShouldAutoMerge } from './auto-merge.js';
import { resolveSpawnPath } from './shell-path.js';
import { effectivePrBaseBranch } from './kanban-pr-base.js';
import {
  applyGithubSpawnCredentials,
  resolveOAuthAppCredentials,
  resolveReviewerGhConfigDir,
} from './spawn-github-credentials.js';
import { getSessionOwner, getOrgOwnerUserId } from './session-ownership.js';
import { getActiveAccessToken } from './github-connections-store.js';
import { ensureSessionWorktreeDependenciesInstalled } from './worktree.js';

/** Max full check passes (initial + post-heal retries). */
const DEFAULT_CHECK_HEAL_MAX_ROUNDS = 2;
const ABSOLUTE_MAX_CHECK_HEAL_ROUNDS = 5;
/** Brief pause after heal + staging before re-running checks (reduces flaky tool races). */
const CHECK_HEAL_BACKOFF_MS = 250;

/**
 * Machine-readable reason for `CheckCommandFailedError` — non-zero exit from a
 * project-configured pre-commit check command only.
 */
export const CHECK_COMMAND_NONZERO_EXIT_CODE = 'check_exit_nonzero' as const;

/** Thrown from `runShellCommandStreaming` when a check command exits with a non-zero numeric code. */
export class CheckCommandFailedError extends Error {
  readonly agentHubErrorCode: typeof CHECK_COMMAND_NONZERO_EXIT_CODE;
  readonly exitCode: number;
  readonly logKind: 'pre_commit';

  constructor(message: string, opts: { exitCode: number; logKind: 'pre_commit' }) {
    super(message);
    this.name = 'CheckCommandFailedError';
    this.agentHubErrorCode = CHECK_COMMAND_NONZERO_EXIT_CODE;
    this.exitCode = opts.exitCode;
    this.logKind = opts.logKind;
  }
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Look up `config.dataDir` defensively for `autoGitChildEnv`'s `GH_CONFIG_DIR`
 * isolation. Returns `null` when deps are uninitialised (unit tests load this
 * module without calling `initAutoGit`) or when `getConfig` throws — in those
 * cases `autoGitChildEnv` simply omits `GH_CONFIG_DIR` and relies on the
 * env-scrub + empty-credential-helper alone to neutralise host gh auth.
 */
function safeResolveDataDir(): string | null {
  try {
    const dataDir = deps?.getConfig?.().dataDir;
    return typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : null;
  } catch {
    return null;
  }
}

/**
 * Append a single `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` entry to the
 * env. Defensive numeric parse on `GIT_CONFIG_COUNT` so a malformed inherited
 * value doesn't clobber prior entries. Mirrors the private helper in
 * `spawn-github-credentials.ts`; duplicated here so the env-scrub path
 * doesn't have to cross a module boundary just for the bookkeeping.
 */
function appendGitConfigEntry(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const prevCountRaw = env.GIT_CONFIG_COUNT;
  const prevCount = (() => {
    if (typeof prevCountRaw !== 'string') return 0;
    const n = Number.parseInt(prevCountRaw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();
  const idx = prevCount;
  env.GIT_CONFIG_COUNT = String(prevCount + 1);
  env[`GIT_CONFIG_KEY_${idx}`] = key;
  env[`GIT_CONFIG_VALUE_${idx}`] = value;
}

/**
 * Child env for `git` / shell steps in this module. Uses the same PATH merge as
 * `buildSpawnEnv` (login shell + fallbacks) without importing `config.ts` — that
 * module has import-time side effects that break unit tests which mock `fs`.
 *
 * **Identity isolation is unconditional.** The host operator's `gh auth login`
 * on the Hub box is typically the GitHub-App installation identity
 * (`app/agent-hub-reviewer`). If `autoGitChildEnv` simply inherited
 * `process.env` whenever no per-session-owner OAuth token was reachable,
 * `git push` / `gh pr create` in `commitPushAndCreatePR` would silently
 * piggy-back on that identity — and PRs that should be authored by the human
 * session owner would instead be opened by the reviewer bot. Same root cause
 * as the spawn-side leak fixed by `applyReviewerSpawnIsolation` (PR #612);
 * the server-side auto-git path had never been given the equivalent
 * treatment.
 *
 * Effects (applied on EVERY call, with or without a supplied `githubToken`):
 *   - Scrub `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
 *     `GITHUB_ENTERPRISE_TOKEN`. `gh` reads `GH_TOKEN` at higher priority
 *     than `GH_CONFIG_DIR`, so leaving these in the env would let the host
 *     operator's identity satisfy `gh pr create` regardless of any other
 *     isolation we apply.
 *   - Append a process-scoped empty `credential.https://github.com.helper`
 *     entry via `GIT_CONFIG_*`. Per git's credential-helper merge rules an
 *     empty value clears the accumulated helper list from earlier config
 *     sources (system, global `~/.gitconfig`, local) so `git push` cannot
 *     satisfy its credential prompt via the host's `gh auth setup-git`
 *     chain.
 *   - Point `GH_CONFIG_DIR` at the Hub-managed reviewer-isolation directory
 *     (`config.dataDir/reviewer-gh-config`) so `gh` cannot fall back to the
 *     host operator's `~/.config/gh/hosts.yml`. Skipped only when
 *     `config.dataDir` is unavailable (uninitialised deps in tests).
 *
 * When a `githubToken` is supplied (normal path — session owner has a
 * connected GitHub account), the working credential helper is appended
 * after the empty entry and `GH_TOKEN` / `GITHUB_TOKEN` are re-set so
 * `gh` / `git push` authenticate as the human owner.
 *
 * When no `githubToken` is supplied the env carries no usable GitHub
 * credential at all — `git push` and `gh pr create` will fail loudly with
 * "could not read Username for 'https://github.com'".
 * `commitPushAndCreatePR` already routes those failures through
 * `persistAndBroadcastPrFailure`, so the human sees a clear UI message
 * rather than silently shipping a bot-PR.
 */
export function autoGitChildEnv(githubToken?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolveSpawnPath(process.env.PATH) };

  // Always scrub inherited GitHub token vars + GH_CONFIG_DIR. The Hub
  // process can itself be running inside a spawned agent's env (e.g. when a
  // session spawns a sub-process that calls back into the same module
  // under test), so just leaving an inherited GH_CONFIG_DIR in place would
  // re-introduce whatever auth the parent had.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  delete env.GH_CONFIG_DIR;

  // Always install the empty credential helper BEFORE any working helper.
  appendGitConfigEntry(env, 'credential.https://github.com.helper', '');

  // Always reroute `GH_CONFIG_DIR` when possible. Best-effort: when deps
  // aren't initialised the env-scrub + empty-helper above are still
  // sufficient to neutralise host gh auth via `git push` (and `gh` will
  // fall back to its own default config dir, which on the prod box is
  // typically the host operator's `~/.config/gh` — we accept that
  // fallback because the alternative is breaking unit tests that load the
  // module without deps).
  const dataDir = safeResolveDataDir();
  if (dataDir) {
    env.GH_CONFIG_DIR = resolveReviewerGhConfigDir({ dataDir });
  }

  if (githubToken) {
    // Append the working helper after the empty entry and set GH_TOKEN /
    // GITHUB_TOKEN. After this `gh pr create` authenticates as the supplied
    // identity and only as that identity.
    applyGithubSpawnCredentials(env, githubToken);
  }

  return env;
}

/**
 * Resolve the GitHub token that auto-git should use for `git push` and
 * `gh pr create` on behalf of `sessionId`.
 *
 * Precedence:
 *   1. Session-owner per-user OAuth/PAT (via `getSessionOwner` →
 *      `getActiveAccessToken`).
 *   2. Org-owner fallback for legacy sessions whose `owner_user_id` row
 *      predates per-user ownership.
 *   3. `null` — fall back to whatever the Hub process inherits
 *      (`~/.gitconfig`, exported `GH_TOKEN`, etc.). Preserves
 *      pre-fix behavior when no per-user token is reachable.
 *
 * Best-effort: every error path returns `null` and logs at warn so the
 * push attempt still runs (and gets a clearer "Authentication failed"
 * error if there really are no usable creds).
 */
export async function resolveAutoGitGithubToken(
  sessionId: string,
  config: Pick<import('./types.js').AppConfig, 'personalOAuth' | 'githubApp'>,
): Promise<string | null> {
  try {
    const ownerId = getSessionOwner(sessionId) || getOrgOwnerUserId();
    if (!ownerId) return null;
    const oauthCreds = resolveOAuthAppCredentials(config);
    return (await getActiveAccessToken(ownerId, oauthCreds)) ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[auto-commit] Could not resolve session-owner GitHub token for ${sessionId}: ${msg}`,
    );
    return null;
  }
}

/**
 * Resolve a GitHub token for a server-side git operation that has NO session
 * scope (e.g. the autonomous loop's operator base-branch probe, which runs
 * before any per-card dispatch and therefore predates the session that will
 * later own the work).
 *
 * Falls back to the org owner. Mirrors `resolveAutoGitGithubToken` in error
 * handling — best-effort, always returns `null` on failure so the caller can
 * still attempt the git operation and surface a clearer "Authentication
 * failed" if there really are no usable creds.
 *
 * Pair the returned token with `autoGitChildEnv(token)` for any `git` /
 * `gh` exec so the credential helper / `GH_TOKEN` are wired the same way the
 * auto-commit push path does it.
 */
export async function resolveOrgOwnerGithubToken(
  config: Pick<import('./types.js').AppConfig, 'personalOAuth' | 'githubApp'>,
): Promise<string | null> {
  try {
    const ownerId = getOrgOwnerUserId();
    if (!ownerId) return null;
    const oauthCreds = resolveOAuthAppCredentials(config);
    return (await getActiveAccessToken(ownerId, oauthCreds)) ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-git] Could not resolve org-owner GitHub token: ${msg}`);
    return null;
  }
}

/** Wall-clock cap per configured pre-commit shell command (lint/test can be slow). */
const PRECOMMIT_CMD_TIMEOUT_MS = 600_000;

/**
 * Max bytes of combined stdout+stderr per spawned child (matches the old
 * `exec({ maxBuffer: 10MiB })` ceiling for project pre-commit shell commands).
 * Applied to `git commit` / `git push` / `gh` streaming as well so runaway CLI
 * output cannot grow without bound or flood WebSocket clients.
 */
export const STREAM_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Cap for `git commit -m <msg>` passed as a single argv element. Kanban cards
 * (especially Codex / autonomous flows) can embed very long descriptions; an
 * oversized message exceeds OS argv limits (Windows is the strictest) and
 * fails with spawn errors instead of a clear git message.
 *
 * On Windows, `CreateProcessW` limits the full command line to 32,767
 * characters (see Microsoft Learn: command-line string max). Node's
 * `execFile` still packs argv into that string, so the `-m` body must leave
 * headroom for `git.exe` path, `commit`, `-m`, and quoting — not 50k.
 */
export const MAX_GIT_COMMIT_MESSAGE_CHARS = 27_000;

/** Strip NULs (invalid in git metadata) and hard-cap length for argv safety. */
export function truncateForGitCommitMessage(message: string): string {
  const noNul = message.replace(/\0/g, '');
  if (noNul.length <= MAX_GIT_COMMIT_MESSAGE_CHARS) return noNul;
  const suffix = '\n\n… (truncated by Agent Hub)';
  const budget = MAX_GIT_COMMIT_MESSAGE_CHARS - suffix.length;
  return noNul.slice(0, Math.max(0, budget)) + suffix;
}

function formatExecFileError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const msg = err.message;
  const stderr = (err as Error & { stderr?: Buffer }).stderr;
  if (stderr?.length) {
    const s = stderr.toString().trim();
    if (s && !msg.includes(s)) return `${msg}\n${s}`;
  }
  return msg;
}

function formatSpawnFailure(
  file: string,
  r: { code: number | null; stdout: string; stderr: string },
): string {
  const parts: string[] = [`${file} exited with code ${r.code}`];
  const e = r.stderr.trim();
  const o = r.stdout.trim();
  if (e) parts.push(e);
  if (o && !e.includes(o)) parts.push(o);
  return parts.join('\n');
}

export function getProjectPreCommitCommands(project: Project): string[] {
  const raw = (project as Record<string, unknown>).preCommitCommands;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Optional shell commands (lint:fix, format, etc.) run after a **check** command
 * from {@link getProjectPreCommitCommands} exits non-zero. Only “safe” failures
 * trigger heal — see `isEligibleCheckFailureForAutoHeal`.
 */
export function getProjectCheckHealCommands(project: Project): string[] {
  const raw = (project as Record<string, unknown>).checkHealCommands;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Max number of full check passes (first run + retries after heal). Clamped to
 * [1, ABSOLUTE_MAX_CHECK_HEAL_ROUNDS]. Ignored when `getProjectCheckHealCommands` is empty.
 */
export function getProjectCheckHealMaxRounds(project: Project): number {
  const raw = (project as Record<string, unknown>).checkHealMaxRounds;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(ABSOLUTE_MAX_CHECK_HEAL_ROUNDS, Math.max(1, Math.floor(raw)));
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return Math.min(ABSOLUTE_MAX_CHECK_HEAL_ROUNDS, Math.max(1, parseInt(raw.trim(), 10)));
  }
  return DEFAULT_CHECK_HEAL_MAX_ROUNDS;
}

/**
 * Whether a thrown error from {@link runShellCommandStreaming} for a check command
 * is in the **auto-healable** class: a normal non-zero exit. Never heal timeouts,
 * output caps, signal kills, spawn failures, or heal-step errors.
 *
 * Prefers `CheckCommandFailedError` / `CHECK_COMMAND_NONZERO_EXIT_CODE` from the throw
 * site; falls back to message shape for older errors or out-of-band callers.
 */
export function isEligibleCheckFailureForAutoHeal(err: Error): boolean {
  if (
    err instanceof CheckCommandFailedError &&
    err.agentHubErrorCode === CHECK_COMMAND_NONZERO_EXIT_CODE &&
    Number.isFinite(err.exitCode) &&
    err.exitCode !== 0
  ) {
    return true;
  }

  const m = err.message;
  if (!m) return false;
  if (m.includes('timed out after')) return false;
  if (m.includes('output exceeded')) return false;
  if (m.includes('Check heal command')) return false;
  const isCheckFailure = m.includes('Pre-commit command failed (');
  if (!isCheckFailure) return false;
  if (/failed \(null\):/.test(m)) return false;
  return true;
}

async function runProjectPreCommitCommands(
  project: Project,
  cwd: string,
  onChunk?: (chunk: string) => void,
): Promise<void> {
  const cmds = getProjectPreCommitCommands(project);
  if (!cmds.length) return;
  const heal = getProjectCheckHealCommands(project);
  const maxRounds = getProjectCheckHealMaxRounds(project);
  await runConfiguredShellChecksWithHeal({
    checkCommands: cmds,
    healCommands: heal,
    maxRounds,
    cwd,
    timeoutMs: PRECOMMIT_CMD_TIMEOUT_MS,
    onChunk,
    logKind: 'pre_commit',
    stageAfterHeal: heal.length > 0,
    logLabel: '[auto-commit]',
    projectId: project.id,
  });
}

export type RunShellCommandLogKind = 'pre_commit' | 'check_heal';

export type RunShellCommandStreamingOptions = {
  maxOutputBytes?: number;
  logKind?: RunShellCommandLogKind;
};

function shellCommandErrorPrefix(kind: RunShellCommandLogKind): string {
  if (kind === 'check_heal') return 'Check heal command';
  return 'Pre-commit command';
}

/**
 * Runs `checkCommands` in order, optionally running `healCommands` + optional
 * `git add -A` between full passes when a failure is eligible for auto-heal.
 */
async function runConfiguredShellChecksWithHeal(opts: {
  checkCommands: string[];
  healCommands: string[];
  maxRounds: number;
  cwd: string;
  timeoutMs: number;
  onChunk?: (chunk: string) => void;
  logKind: RunShellCommandLogKind;
  stageAfterHeal: boolean;
  logLabel: string;
  projectId: string;
}): Promise<void> {
  const {
    checkCommands,
    healCommands,
    maxRounds,
    cwd,
    timeoutMs,
    onChunk,
    logKind,
    stageAfterHeal,
    logLabel,
    projectId,
  } = opts;

  const cappedRounds =
    healCommands.length === 0
      ? 1
      : Math.min(ABSOLUTE_MAX_CHECK_HEAL_ROUNDS, Math.max(1, maxRounds));

  for (let round = 1; round <= cappedRounds; round++) {
    try {
      onChunk?.(`\n## Check round ${round}/${cappedRounds}\n`);
      for (const cmd of checkCommands) {
        console.log(`${logLabel} (${projectId}) round ${round}/${cappedRounds}: ${cmd}`);
        onChunk?.(`\n$ ${cmd}\n`);
        await runShellCommandStreaming(cmd, cwd, timeoutMs, onChunk, { logKind });
      }
      return;
    } catch (e) {
      const lastErr = e instanceof Error ? e : new Error(String(e));
      const triesLeft = cappedRounds - round;
      const canHeal =
        triesLeft > 0 && healCommands.length > 0 && isEligibleCheckFailureForAutoHeal(lastErr);

      if (!canHeal) {
        let hint = '';
        if (!healCommands.length) {
          hint =
            '\n\n[auto-heal] No `checkHealCommands` configured — add lint/format fixers under Project Settings to retry automatically after fixable failures.';
        } else if (!isEligibleCheckFailureForAutoHeal(lastErr)) {
          hint =
            '\n\n[auto-heal] This failure is not auto-healed (only non-zero exits from check commands; timeouts, output caps, and signal kills are excluded).';
        } else if (triesLeft <= 0) {
          hint = `\n\n[auto-heal] Exhausted ${cappedRounds} check round(s). See the log above for each attempt.`;
        }
        throw new Error(lastErr.message + hint);
      }

      onChunk?.(
        `\n### Auto-heal (round ${round})\n\nCheck failed with a fixable exit code. Running ${healCommands.length} heal command(s)${stageAfterHeal ? ', then `git add -A`' : ''}, then retrying all checks.\n`,
      );

      for (const h of healCommands) {
        console.log(`${logLabel} heal (${projectId}): ${h}`);
        onChunk?.(`\n$ ${h}\n`);
        await runShellCommandStreaming(h, cwd, timeoutMs, onChunk, { logKind: 'check_heal' });
      }

      if (stageAfterHeal) {
        try {
          onChunk?.(`\n$ git add -A\n`);
          await execAsync('git add -A', { cwd });
        } catch (addErr: unknown) {
          const msg = addErr instanceof Error ? addErr.message : String(addErr);
          console.warn(`${logLabel} git add -A after heal failed (non-fatal): ${msg}`);
          onChunk?.(`\n(warning: git add -A failed: ${msg})\n`);
        }
      }

      if (CHECK_HEAL_BACKOFF_MS > 0) {
        await new Promise<void>((r) => setTimeout(r, CHECK_HEAL_BACKOFF_MS));
      }
    }
  }
}

/**
 * Run a shell command with live stdout/stderr (used for project pre-commit
 * hooks configured on the Agent Hub project row).
 *
 * @param maxOutputBytesOrOpts — max bytes as a number (legacy), or an options
 *   object with `maxOutputBytes` and/or `logKind` for error-message wording.
 */
export async function runShellCommandStreaming(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
  maxOutputBytesOrOpts: number | RunShellCommandStreamingOptions = STREAM_OUTPUT_MAX_BYTES,
): Promise<void> {
  let maxOutputBytes = STREAM_OUTPUT_MAX_BYTES;
  let logKind: RunShellCommandLogKind = 'pre_commit';
  if (typeof maxOutputBytesOrOpts === 'number') {
    maxOutputBytes = maxOutputBytesOrOpts;
  } else if (maxOutputBytesOrOpts && typeof maxOutputBytesOrOpts === 'object') {
    if (maxOutputBytesOrOpts.maxOutputBytes != null)
      maxOutputBytes = maxOutputBytesOrOpts.maxOutputBytes;
    if (maxOutputBytesOrOpts.logKind) logKind = maxOutputBytesOrOpts.logKind;
  }
  const errPrefix = shellCommandErrorPrefix(logKind);
  const isWin = process.platform === 'win32';
  const spawnEnv = autoGitChildEnv();
  const child = isWin
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
        cwd,
        env: spawnEnv,
        windowsHide: true,
      })
    : spawn('/bin/sh', ['-c', cmd], { cwd, env: spawnEnv });

  let received = 0;
  let overBudget = false;
  const onData = (d: string | Buffer) => {
    if (overBudget) return;
    const s = typeof d === 'string' ? d : d.toString();
    const n = Buffer.byteLength(s, 'utf8');
    if (received + n > maxOutputBytes) {
      overBudget = true;
      child.kill('SIGTERM');
      return;
    }
    received += n;
    onChunk?.(s);
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${errPrefix} timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (overBudget) {
        reject(
          new Error(
            `${errPrefix} output exceeded ${maxOutputBytes} bytes: ${cmd}`.substring(0, 5000),
          ),
        );
        return;
      }
      if (code === 0) resolve();
      else {
        const msg = `${errPrefix} failed (${code ?? signal ?? 'unknown'}): ${cmd}`.substring(
          0,
          5000,
        );
        if (logKind === 'pre_commit' && typeof code === 'number' && code !== 0) {
          reject(
            new CheckCommandFailedError(msg, {
              exitCode: code,
              logKind: 'pre_commit',
            }),
          );
          return;
        }
        reject(new Error(msg));
      }
    });
  });
}

type SpawnChunkHandler = (chunk: string) => void;

async function spawnProcessStreaming(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    onChunk?: SpawnChunkHandler;
    maxOutputBytes?: number;
    /**
     * Per-session GitHub token (OAuth/PAT) to inject into the child env so
     * `git push` / `gh` authenticate as the session owner. When omitted/null,
     * inherits the Hub process's ambient git/gh auth (pre-fix behavior).
     */
    githubToken?: string | null;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const maxOut = opts.maxOutputBytes ?? STREAM_OUTPUT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: autoGitChildEnv(opts.githubToken),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let received = 0;
    let overBudget = false;
    const push = (buf: Buffer, which: 'out' | 'err') => {
      if (overBudget) return;
      const s = buf.toString();
      const n = Buffer.byteLength(s, 'utf8');
      if (received + n > maxOut) {
        overBudget = true;
        child.kill('SIGTERM');
        return;
      }
      received += n;
      if (which === 'out') stdout += s;
      else stderr += s;
      opts.onChunk?.(s);
    };
    child.stdout?.on('data', (d: Buffer) => push(d, 'out'));
    child.stderr?.on('data', (d: Buffer) => push(d, 'err'));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${opts.timeoutMs}ms: ${file} ${args.join(' ')}`));
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (overBudget) {
        reject(
          new Error(
            `${file} output exceeded ${maxOut} bytes (argv: ${args.join(' ').substring(0, 200)}…)`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run `gh` without a shell so PR bodies can contain backticks, `$`, `{`, etc. */
async function runGh(
  args: string[],
  cwd: string,
  timeout?: number,
  /**
   * Per-session GitHub token to inject so `gh` authenticates as the session
   * owner. When omitted/null, `gh` falls back to its ambient login (host
   * `gh auth status` / inherited `GH_TOKEN`). See `autoGitChildEnv` JSDoc.
   */
  githubToken?: string | null,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('gh', args, { cwd, timeout, env: autoGitChildEnv(githubToken) });
}

/** Same argv safety as `runGh`, with optional live stdout/stderr for the UI. */
async function runGhStreamed(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChunk?: SpawnChunkHandler,
  githubToken?: string | null,
): Promise<{ stdout: string; stderr: string }> {
  if (!onChunk) {
    return runGh(args, cwd, timeoutMs, githubToken);
  }
  const r = await spawnProcessStreaming('gh', args, { cwd, timeoutMs, onChunk, githubToken });
  if (r.code !== 0) {
    const err = new Error(formatSpawnFailure('gh', r)) as Error & { stderr?: Buffer };
    err.stderr = Buffer.from(r.stderr || '');
    throw err;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

// ─── Dependency Types ────────────────────────────────────────────────

interface AutoGitDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getConfig: () => AppConfig;
  DEFAULT_SKILLS_DIR: string;
}

interface SlashSkillResult {
  skillName: string;
  userArgs: string;
  error?: undefined;
}

interface SlashSkillError {
  error: string;
}

// ─── Module-level state ──────────────────────────────────────────────
let deps: AutoGitDeps | null = null;

function getDeps(): AutoGitDeps {
  if (!deps) throw new Error('auto-git: initAutoGit() must be called before use');
  return deps;
}

// ─── Initialisation ──────────────────────────────────────────────────

export function initAutoGit(d: AutoGitDeps): void {
  deps = d;
}

// ─── Slash-command skill resolution ─────────────────────────────────

export function resolveSlashSkill(
  agent: Agent,
  content: string,
  project: Project | undefined,
): SlashSkillResult | SlashSkillError | null {
  const ahw = project?.ahw || agent.ahw || (agent as Record<string, unknown>).workspace;
  if (!content.startsWith('/')) return null;

  const match = content.match(/^\/([a-zA-Z0-9_.-]+)(\s[\s\S]*)?$/);
  if (!match) return null;

  const skillName = match[1];
  const userArgs = match[2] ? match[2].trim() : '';

  const d = getDeps();
  const searchDirs: string[] = [];
  if (ahw) searchDirs.push(path.join(ahw as string, 'skills'));
  searchDirs.push(d.DEFAULT_SKILLS_DIR);

  for (const skillsDir of searchDirs) {
    if (!existsSync(skillsDir)) continue;

    const dirPath = path.join(skillsDir, skillName);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      const skillMd = path.join(dirPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        return { skillName, userArgs };
      }
    }

    const mdPath = skillName.endsWith('.md')
      ? path.join(skillsDir, skillName)
      : path.join(skillsDir, skillName + '.md');
    if (existsSync(mdPath) && !statSync(mdPath).isDirectory()) {
      return { skillName: skillName.replace(/\.md$/i, ''), userArgs };
    }
  }

  return { error: `Skill "/${skillName}" not found` };
}

// ─── PR title / body formatting ─────────────────────────────────────

/**
 * Reject commit subjects that don't describe meaningful work — fixup/squash
 * markers, "wip", purely-mechanical lint/format/typo commits. These are not
 * useful as PR titles even if they are the only commits on the branch.
 */
const GENERIC_COMMIT_PATTERNS: RegExp[] = [
  /^(wip|tmp|temp)\b/i,
  // fixup!/squash!/amend! markers — `\b` after `!` doesn't fire (non-word
  // boundary), so anchor on the optional space directly.
  /^(fixup|squash|amend)!\s/i,
  // Conventional-commit-style "fix typo" / "chore: format" / "test: lint" etc.
  /^(fix|chore|style|test|docs|build|ci)(\(.*\))?:\s*(typo|typos|lint|format|formatting|whitespace|tidy|cleanup|cleanups)\b/i,
  // Non-prefixed mechanical commits ("fix typo", "fix lint", "tidy imports").
  /^(fix|update)\s+(typo|typos|lint|format|formatting|whitespace|imports?|test\s+name)\b/i,
  /^(tidy|cleanup|format(ting)?|prettier|eslint)\b/i,
  /^merge\s+(branch|pull request|remote)/i,
  /^revert\s+/i,
];

function isGenericCommitSubject(subject: string): boolean {
  return GENERIC_COMMIT_PATTERNS.some((re) => re.test(subject));
}

/**
 * A commit summarised down to the parts the PR formatters care about.
 *
 * `subject` is the first line of the commit message (`git log %s`).
 * `body` is everything after the subject + blank line (`git log %b`),
 * trimmed of trailing whitespace. Empty body is normalised to `''` so callers
 * can treat the field as optional/absent uniformly.
 */
export interface CommitInfo {
  subject: string;
  body?: string;
}

/**
 * Normalise the union of legacy `string[]` (subject-only) and `CommitInfo[]`
 * (subject + body) inputs to a uniform `CommitInfo[]` shape. Empty / falsy
 * subjects are filtered. Bodies are trimmed; missing/empty bodies remain
 * `undefined` so callers can branch cleanly on `if (body)`.
 *
 * Exported for tests; production code paths normalise once at the top of
 * each formatter.
 */
export function normalizeCommitInputs(
  commits: ReadonlyArray<string | CommitInfo> | undefined,
): CommitInfo[] {
  if (!commits) return [];
  const out: CommitInfo[] = [];
  for (const c of commits) {
    if (typeof c === 'string') {
      const subject = c.trim();
      if (!subject) continue;
      out.push({ subject });
    } else if (c && typeof c === 'object') {
      const subject = (c.subject ?? '').trim();
      if (!subject) continue;
      const body = (c.body ?? '').trim();
      out.push(body ? { subject, body } : { subject });
    }
  }
  return out;
}

/**
 * Pick the most descriptive commit subject from a branch's commit list to use
 * as the PR title. Returns null if every commit looks generic / non-descriptive
 * (in which case the caller should fall back to the card / session title).
 *
 * Commits are expected newest-first (the order `git log main..HEAD` returns).
 * We prefer the newest non-generic subject — it usually reflects the final
 * shape of the change after any fixups.
 *
 * Accepts either a `string[]` (subjects only — legacy callers like
 * `handoff.ts` and pre-body tests) or a `CommitInfo[]` (subject + body). Only
 * subjects are inspected for genericness, so the body field is structurally
 * irrelevant here — but accepting both shapes keeps the call sites single.
 */
export function pickPrTitleFromCommits(
  commits: ReadonlyArray<string | CommitInfo> | undefined,
): string | null {
  if (!commits) return null;
  for (const raw of commits) {
    const subject = typeof raw === 'string' ? (raw ?? '').trim() : (raw?.subject ?? '').trim();
    if (!subject) continue;
    if (isGarbageTitle(subject)) continue;
    if (isGenericCommitSubject(subject)) continue;
    return subject;
  }
  return null;
}

/**
 * Turn a raw commit/card title into a clean PR title.
 *
 * - When `commits` is supplied and contains at least one descriptive commit
 *   subject, that subject wins — commit messages describe what was *done*,
 *   while card / session titles often capture what was *asked* (and may be a
 *   long problem statement that gets truncated mid-word at the 70-char cap).
 * - Otherwise falls back to `rawTitle`.
 * - Collapses whitespace, trims trailing punctuation.
 * - Sentence-cases the first letter (unless it's already uppercased).
 * - Hard-caps at 70 chars, preferring a word boundary and appending an
 *   ellipsis (`…`) rather than `...` mid-word.
 */
export function buildPrTitle(
  rawTitle: string,
  commits?: ReadonlyArray<string | CommitInfo>,
): string {
  const fromCommit = pickPrTitleFromCommits(commits);
  const source = fromCommit ?? rawTitle;
  const normalized = (source ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled change';

  // Strip trailing punctuation/whitespace (GitHub convention: no period).
  let t = normalized.replace(/[.!?:;,\s]+$/, '');

  // Sentence-case the first letter if it's a lowercase ASCII letter. Leave
  // existing capitalization alone for acronyms / scoped prefixes like `Fix:`,
  // and preserve lowercase Conventional Commits prefixes (feat:, fix:,
  // chore:, docs:, refactor:, test:, build:, ci:, perf:, style:, revert:)
  // since the spec — and most repos following it — expect lowercase.
  const CONVENTIONAL_COMMIT =
    /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\(.+?\))?!?:\s/i;
  if (/^[a-z]/.test(t) && !CONVENTIONAL_COMMIT.test(t)) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  const MAX = 70;
  if (t.length <= MAX) return t;

  // Truncate at the last word boundary within the limit, falling back to a
  // hard clip only when the first "word" exceeds MAX.
  const clipped = t.substring(0, MAX - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(MAX * 0.6) ? clipped.substring(0, lastSpace) : clipped;
  return cut.replace(/[.!?:;,\s]+$/, '') + '…';
}

export interface PrBodyInput {
  card?: KanbanCardRow;
  agentName: string;
  /**
   * Commits on the branch, newest first.
   *
   * - Legacy `string[]` form (subjects only): preserved for back-compat with
   *   tests and handoff-style callers that don't have bodies.
   * - `CommitInfo[]` form: subject + optional body. When a body is present,
   *   `buildPrBody` will use it in the Summary (single-commit branches) and
   *   render it as indented detail under each bullet (multi-commit
   *   branches). Generic-commit filtering still operates on subjects only.
   */
  commits?: ReadonlyArray<string | CommitInfo>;
  diffStat?: string;
}

/**
 * Render a clean, readable PR body:
 *
 *   ## Summary
 *   <commit subject(s) when present — describes what was DONE>
 *   <else card description — describes what was ASKED>
 *   <else "Task completed by <agent>.">
 *
 *   ## Commits   (only when >1 commit — one commit is already the summary)
 *   - commit subject
 *   - ...
 *
 *   ## Original task   (only when commits drove the summary AND a card description exists)
 *   <card description, indented as a quote>
 *
 *   ## Files changed   (only when a diffstat is available)
 *   ```
 *   path/to/file | 12 ++++------
 *   ...
 *   ```
 *
 *   ---
 *   Agent: **dev** · Priority: `medium` · Labels: `bug`, `p1`
 *
 *   _Automated PR from Agent Hub · kanban card card-abc123_
 *
 * Empty priority/labels are omitted rather than rendered as dangling headers.
 */
export function buildPrBody(input: PrBodyInput): string {
  const { card, agentName, commits, diffStat } = input;
  const sections: string[] = [];

  // Summary — prefer the agent's commit subject(s) over the card description.
  // Commit subjects describe what was *done*; card descriptions describe what
  // was *asked* — and the card description is preserved below as origin
  // context. Falls back to the card description, then to a generic marker.
  //
  // When a commit *body* is present (CommitInfo form), single-commit PRs use
  // the body as the Summary — that's where the agent's "why" usually lives,
  // while the subject often duplicates the title. Empty bodies fall back to
  // the subject so the legacy subject-only path is unchanged.
  const commitList = normalizeCommitInputs(commits);
  const cardDescription = card?.description?.trim() || '';
  const commitDrivenSummary = commitList.length > 0;
  let summary: string;
  if (commitList.length === 1) {
    const only = commitList[0];
    summary = only.body ? `${only.subject}\n\n${only.body}` : only.subject;
  } else if (commitList.length > 1) {
    // For multi-commit branches the bulleted ## Commits section below renders
    // the full list; here in Summary we surface a one-line lede so the PR is
    // skimmable. Prefer the most recent (newest-first) descriptive subject.
    summary = pickPrTitleFromCommits(commitList) ?? commitList[0].subject;
  } else if (cardDescription) {
    summary = cardDescription;
  } else {
    summary = `Task completed by ${agentName}.`;
  }
  sections.push('## Summary');
  sections.push(summary);

  // Commits — only list when there's more than one, otherwise the single
  // commit subject + body is already the summary and listing it is noise.
  // Each bullet renders the subject; if the commit has a body we render it
  // as indented detail (4-space indent so GitHub keeps the bullet's hanging
  // alignment) capped at a few lines per commit so squash-style merges with
  // long bodies don't blow up the PR description.
  if (commitList.length > 1) {
    sections.push('');
    sections.push('## Commits');
    const MAX_COMMITS = 20;
    const MAX_BODY_LINES_PER_COMMIT = 10;
    const shown = commitList.slice(0, MAX_COMMITS);
    for (const c of shown) {
      sections.push(`- ${c.subject}`);
      if (c.body) {
        const lines = c.body.split('\n');
        const truncated = lines.length > MAX_BODY_LINES_PER_COMMIT;
        const rendered = truncated
          ? [...lines.slice(0, MAX_BODY_LINES_PER_COMMIT - 1), '…'].join('\n')
          : c.body;
        // Prefix each body line with 4 spaces so it renders as indented
        // continuation under the bullet on GitHub.
        sections.push(
          rendered
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n'),
        );
      }
    }
    if (commitList.length > MAX_COMMITS) {
      sections.push(`- …and ${commitList.length - MAX_COMMITS} more`);
    }
  }

  // Original task — preserve the card description (problem statement) as
  // origin context, but only when commits already drove the Summary above.
  // Without this, the long user-prose card description would either be the
  // Summary (wrong — it's the problem, not the solution) or be lost entirely.
  if (commitDrivenSummary && cardDescription) {
    sections.push('');
    sections.push('## Original task');
    sections.push(cardDescription);
  }

  // Files changed — render the git diff --stat output verbatim in a code
  // block, capped so huge refactors don't blow up the PR body.
  const statTrimmed = (diffStat ?? '').trim();
  if (statTrimmed) {
    sections.push('');
    sections.push('## Files changed');
    sections.push('```');
    const statLines = statTrimmed.split('\n');
    const MAX_FILE_LINES = 20;
    const rendered =
      statLines.length > MAX_FILE_LINES
        ? [
            ...statLines.slice(0, MAX_FILE_LINES - 1),
            `…and ${statLines.length - (MAX_FILE_LINES - 1)} more`,
          ].join('\n')
        : statLines.join('\n');
    sections.push(rendered);
    sections.push('```');
  }

  // Metadata footer — single-line, fields omitted when empty.
  const meta: string[] = [`Agent: **${agentName}**`];
  if (card?.priority) meta.push(`Priority: \`${card.priority}\``);
  if (card?.labels) {
    const labels = card.labels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (labels.length) {
      meta.push(`Labels: ${labels.map((l) => `\`${l}\``).join(', ')}`);
    }
  }

  sections.push('');
  sections.push('---');
  sections.push(meta.join(' · '));
  sections.push('');
  sections.push(
    card
      ? `_Automated PR from Agent Hub · kanban card ${card.id}_`
      : '_Automated PR from Agent Hub_',
  );

  return sections.join('\n');
}

/**
 * Collect the commit subjects that would appear in this PR: commits on the
 * current branch that are not on `main`. Newest first. Best-effort — returns
 * an empty array on any git failure (missing `main` ref, detached HEAD, etc.).
 *
 * Retained for back-compat with any future callers that only need subjects.
 * The PR pipeline uses {@link collectCommits} so that bodies make it into the
 * PR description.
 */
async function collectCommitSubjects(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git log main..HEAD --format=%s', {
      cwd,
      timeout: 10000,
    });
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Collect the full commit message for each commit on the branch (subject +
 * body), newest first. Returns an empty array on any git failure so callers
 * can degrade to the card / session title pipeline without special-casing.
 *
 * Implementation: `git log -z` separates commits with a NUL byte, which lets
 * the body contain arbitrary characters (newlines, blank lines, even literal
 * separators) without escaping. Within each NUL-separated record we use the
 * first line as the subject (`%s`) and the remainder (after the standard
 * blank line) as the body (`%b`). Empty bodies become `undefined` on the
 * returned `CommitInfo` so downstream formatters can branch on presence.
 */
async function collectCommits(cwd: string): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execAsync('git log main..HEAD -z --format=%s%n%b', {
      cwd,
      timeout: 10000,
    });
    if (!stdout) return [];
    const records = stdout.split('\0');
    const out: CommitInfo[] = [];
    for (const rec of records) {
      const trimmed = rec.replace(/\n+$/, '');
      if (!trimmed) continue;
      const newlineIdx = trimmed.indexOf('\n');
      const subject = (newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx)).trim();
      if (!subject) continue;
      const rawBody = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1).trim();
      out.push(rawBody ? { subject, body: rawBody } : { subject });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Collect a `git diff --stat` summary of the branch vs. `main`. Best-effort —
 * returns an empty string on failure.
 */
async function collectDiffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git diff --stat main...HEAD', {
      cwd,
      timeout: 10000,
    });
    return stdout;
  } catch {
    return '';
  }
}

// ─── Auto-commit & PR on agent completion ───────────────────────────

/**
 * Move a card to the Review column and persist the PR URL on it.
 *
 * NOTE: This used to also dispatch the lead-review pipeline. As of the unified
 * reviewer refactor, PR review fires from the GitHub webhook on
 * `pull_request.opened` / `pull_request.synchronize`, so this function is now
 * purely a UI/state update — the dedicated Reviewer agent will be dispatched
 * by the webhook handler when GitHub announces the new PR/push.
 */
function moveCardToReview(card: KanbanCardRow, project: Project, prUrl: string | null): void {
  const d = getDeps();
  if (prUrl) {
    try {
      d.stmts.setCardPrUrl.run(prUrl, card.id);
    } catch (_e: unknown) {
      /* non-critical */
    }
  }

  const board = d.stmts.getKanbanBoard?.get(project.id) as { id: string } | undefined;
  if (board) {
    const cols = d.stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>;
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (reviewCol) {
      d.stmts.moveKanbanCard.run(reviewCol.id, 0, card.id);
      d.broadcast({ type: 'kanban_update', projectId: project.id });
      console.log(`[auto-commit] Card "${card.title}" moved to Review`);
    }
  }
}

// ─── Build card description from session context ───────────────────

export function buildCardDescription(messages: MessageRow[], diffStat: string): string {
  const lines: string[] = [];

  // Extract the first user message as the task/problem statement
  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (firstUserMsg) {
    const taskText = firstUserMsg.content.trim();
    // Truncate long messages to a reasonable summary length
    const maxLen = 500;
    const truncated = taskText.length > maxLen ? taskText.substring(0, maxLen) + '...' : taskText;
    lines.push('### Task');
    lines.push(truncated);
  }

  // Add a "Changes" section from git diff --stat
  if (diffStat.trim()) {
    lines.push('');
    lines.push('### Changes');
    lines.push('```');
    // Limit to first 20 lines of diff stat to keep it concise
    const statLines = diffStat.trim().split('\n');
    const trimmedStat =
      statLines.length > 20
        ? [...statLines.slice(0, 19), `... and ${statLines.length - 19} more files`].join('\n')
        : statLines.join('\n');
    lines.push(trimmedStat);
    lines.push('```');
  }

  return lines.join('\n');
}

// ─── Worktree change detection ──────────────────────────────────────

export interface WorktreeChanges {
  hasUncommitted: boolean;
  hasUnpushed: boolean;
  branch: string;
}

/**
 * Detect the repo's default branch (e.g. `main` or `master`). Mirrors the
 * logic in `worktree.ts` so `checkWorktreeChanges` doesn't silently assume
 * `main` and miss "has commits ahead of default branch" for master repos
 * (or any fresh local branch whose upstream is not yet set).
 *
 * Order:
 *   1. `origin/HEAD` symbolic ref (most reliable; tracks remote's default).
 *   2. Local `main` if it exists.
 *   3. Local `master` if it exists.
 *   4. `null` — caller should treat this as "unknown" rather than silently
 *      assuming `hasUnpushed = false`.
 */
async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd });
    const ref = stdout.trim().replace('refs/remotes/origin/', '');
    if (ref) return ref;
  } catch {
    // origin/HEAD not set — try local branches
  }
  for (const candidate of ['main', 'master']) {
    try {
      await execAsync(`git rev-parse --verify ${candidate}`, { cwd });
      return candidate;
    } catch {
      // branch doesn't exist locally
    }
  }
  return null;
}

export async function checkWorktreeChanges(cwd: string): Promise<WorktreeChanges> {
  const { stdout: status } = await execAsync('git status --porcelain', { cwd });
  const hasUncommitted = !!status.trim();

  let hasUnpushed = false;
  let hasUpstream = false;
  try {
    const { stdout: logOut } = await execAsync('git log @{upstream}..HEAD --oneline', {
      cwd,
    });
    hasUpstream = true;
    hasUnpushed = !!logOut.trim();
  } catch {
    // No upstream configured for this branch — fall through to default-branch
    // comparison so a fresh, never-pushed branch with local commits still
    // surfaces the "Create PR" banner.
  }

  if (!hasUpstream) {
    const defaultBranch = await resolveDefaultBranch(cwd);
    if (defaultBranch) {
      // Try both the local ref and the remote-tracking ref. Prefer
      // `origin/<default>` when available because the local default branch
      // may be stale or absent in a linked worktree.
      for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
        try {
          const { stdout: logOut2 } = await execAsync(`git log ${ref}..HEAD --oneline`, {
            cwd,
          });
          hasUnpushed = !!logOut2.trim();
          break;
        } catch {
          // ref not available — try next candidate
        }
      }
    }
  }

  const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });

  return { hasUncommitted, hasUnpushed, branch: branchOut.trim() };
}

// ─── Core commit + PR + review pipeline ─────────────────────────────

/**
 * Fire-and-forget enable of GitHub's native auto-merge on a PR.
 *
 * Resolves the auto-merge decision via `resolveShouldAutoMerge` (per-PR
 * override wins; otherwise the project's `githubWorkflow.autoMerge`).
 *
 * Failures here NEVER bubble up — they must not block PR creation:
 *   - Repo doesn't have "Allow auto-merge" enabled → logged, PR still succeeds
 *   - PR requirements not met → logged warning, PR still succeeds
 *   - Any other failure → logged, doesn't cascade
 */
/** Result of `commitPushAndCreatePR` — discriminated union for logging + API errors. */
export type CommitPushPrResult =
  | { ok: true; prUrl: string }
  | { ok: false; error: string; code: CommitPushPrFailureCode; branch?: string };

export type CommitPushPrFailureCode =
  | 'nothing_to_publish'
  | 'commit_failed'
  | 'push_failed'
  | 'no_diff_vs_base'
  | 'pr_failed';

/** User-facing outcome of `manualCommitAndPR` (Create PR button / API). */
export type ManualPrResult =
  | { ok: true; prUrl: string; cardId: string }
  | { ok: false; error: string; code: string };

function humanizeCommitPrFailure(r: Extract<CommitPushPrResult, { ok: false }>): string {
  switch (r.code) {
    case 'nothing_to_publish':
      return 'Nothing to publish: the worktree is clean and no open pull request was found for this branch.';
    case 'push_failed':
      return `Git push failed: ${r.error}`;
    case 'pr_failed':
      return `Could not open a pull request: ${r.error}`;
    case 'commit_failed':
      return `Git commit failed: ${r.error}`;
    case 'no_diff_vs_base':
      return `No pull request opened: ${r.error}`;
    default:
      return r.error;
  }
}

async function enableAutoMergeIfNeeded(
  prUrl: string,
  project: Project,
  override: boolean | undefined,
  cwd: string,
  githubToken?: string | null,
): Promise<void> {
  if (!resolveShouldAutoMerge(override, project.githubWorkflow)) return;
  try {
    await runGh(['pr', 'merge', '--auto', '--squash', prUrl], cwd, 15000, githubToken);
    console.log(`[auto-merge] Enabled GitHub native auto-merge for ${prUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-merge] Failed to enable auto-merge for ${prUrl}: ${msg}`);
  }
}

/**
 * If we adopt an existing PR for a branch but the operator requested a
 * specific base (via `card.pr_base_branch` or `epic.pr_base_branch`),
 * retarget the PR via `gh pr edit --base <branch>` so adoption never
 * silently inherits the wrong base.
 *
 * Closes the gap where the agent (against the chat.ts prompt) ran
 * `gh pr create` directly with no `--base` BEFORE the server's auto-PR
 * fired — the server would then find the existing PR and rubber-stamp it
 * onto whatever default branch `gh` picked.
 *
 * Failures are logged + commented but never block card progression — the
 * worst case is the operator sees the warning and runs `gh pr edit` by
 * hand. Returns true when the retarget actually changed the PR.
 */
async function retargetExistingPrIfNeeded(
  existingPrUrl: string,
  resolvedBaseBranch: string | null,
  card: KanbanCardRow | undefined,
  project: Project,
  cwd: string,
  githubToken: string | null | undefined,
): Promise<boolean> {
  if (!resolvedBaseBranch) return false;
  const d = getDeps();
  let currentBase: string;
  try {
    const { stdout } = await runGh(
      ['pr', 'view', existingPrUrl, '--json', 'baseRefName', '--jq', '.baseRefName'],
      cwd,
      15000,
      githubToken,
    );
    currentBase = stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[auto-commit] PR base check failed for ${existingPrUrl}; leaving base unchanged: ${msg}`,
    );
    return false;
  }
  if (!currentBase || currentBase === resolvedBaseBranch) return false;

  try {
    await runGh(
      ['pr', 'edit', existingPrUrl, '--base', resolvedBaseBranch],
      cwd,
      15000,
      githubToken,
    );
    console.log(
      `[auto-commit] Retargeted PR ${existingPrUrl}: base ${currentBase} → ${resolvedBaseBranch}`,
    );
    if (card) {
      try {
        d.stmts.createKanbanCardComment.run(
          crypto.randomUUID(),
          card.id,
          'Agent Hub',
          `Retargeted PR base from **${currentBase}** → **${resolvedBaseBranch}** to match this card's configured override.`,
        );
        d.broadcast({ type: 'kanban_update', projectId: project.id });
      } catch (commentErr: unknown) {
        const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);
        console.warn(`[auto-commit] Failed to post retarget comment: ${msg}`);
      }
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[auto-commit] gh pr edit failed for ${existingPrUrl} (${currentBase} → ${resolvedBaseBranch}): ${msg}`,
    );
    if (card) {
      try {
        d.stmts.createKanbanCardComment.run(
          crypto.randomUUID(),
          card.id,
          'Agent Hub',
          `⚠️ Tried to retarget this PR's base from **${currentBase}** → **${resolvedBaseBranch}** but \`gh pr edit\` failed: ${msg}. Run \`gh pr edit ${existingPrUrl} --base ${resolvedBaseBranch}\` manually if needed.`,
        );
        d.broadcast({ type: 'kanban_update', projectId: project.id });
      } catch (commentErr: unknown) {
        const cmsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
        console.warn(`[auto-commit] Failed to post retarget-failure comment: ${cmsg}`);
      }
    }
    return false;
  }
}

function sessionInstallCommand(project: Project): string | null {
  const install = (project as Project & { commands?: { install?: string } }).commands?.install;
  return typeof install === 'string' ? install : null;
}

async function commitPushAndCreatePR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  card: KanbanCardRow | undefined,
  options?: { autoMergeOverride?: boolean },
): Promise<CommitPushPrResult> {
  const d = getDeps();

  // Resolve the session owner's GitHub token ONCE per invocation. Threaded
  // into every `git ls-remote` / `git push` / `gh` spawn so HTTPS probes,
  // pushes, and PR opens authenticate as the human owner of the repo.
  // Closes the "Authentication failed for 'https://github.com/<user>/repo.git/'"
  // failure mode for autonomous-dispatch sessions whose spawn env was deliberately
  // stripped of GitHub credentials.
  const githubToken = await resolveAutoGitGithubToken(sessionId, d.getConfig());

  // ── PR base-branch override (hoisted) ─────────────────────────────
  //
  // Cards may override the PR base via `card.pr_base_branch` (e.g. for
  // stacked PRs) or inherit one from their linked epic (`epic.pr_base_branch`,
  // the integration-branch design). Hoisted above the worktree-changes check
  // so it applies to all three adoption paths:
  //   1. clean worktree + existing PR (early return below)
  //   2. existing-PR pre-check before `gh pr create`
  //   3. fresh `gh pr create --base <branch>`
  // Without this, paths 1 and 2 would silently inherit whatever base the
  // pre-existing PR was opened with — including the repo default when an
  // agent ran `gh pr create` directly against the chat.ts prompt warning.
  let resolvedBaseBranch: string | null = null;
  let baseBranchFellBack = false;
  let baseBranchFallbackReason: string | null = null;
  let linkedEpic: KanbanEpicRow | undefined;
  if (card?.epic_id) {
    linkedEpic = d.stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined;
  }
  const requestedBaseRaw = effectivePrBaseBranch(card, linkedEpic);
  const requestedBase = requestedBaseRaw?.trim();
  // Defensive re-validation of the persisted value before we hand it to
  // `gh`. The PUT route already enforces this regex, but we don't want a
  // hand-edited DB row to escape into a spawned argv.
  const isSafeBranch = (s: string) => /^[A-Za-z0-9._/-]+$/.test(s);

  if (requestedBase && isSafeBranch(requestedBase)) {
    try {
      const { stdout: lsOut } = await execFileAsync(
        'git',
        ['ls-remote', '--heads', 'origin', requestedBase],
        {
          cwd: effectiveCwd,
          timeout: 10_000,
          env: autoGitChildEnv(githubToken),
        },
      );
      if (lsOut.trim()) {
        resolvedBaseBranch = requestedBase;
      } else {
        baseBranchFellBack = true;
        baseBranchFallbackReason = `branch "${requestedBase}" no longer exists on origin`;
      }
    } catch (err: unknown) {
      baseBranchFellBack = true;
      baseBranchFallbackReason = `branch lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  } else if (requestedBase && !isSafeBranch(requestedBase)) {
    baseBranchFellBack = true;
    baseBranchFallbackReason = `persisted base branch "${requestedBase}" failed validation; ignored`;
  }

  if (baseBranchFellBack && card) {
    const defaultBranch = (await resolveDefaultBranch(effectiveCwd)) ?? '(repo default)';
    const note = `Configured PR base branch override was not used — falling back to **${defaultBranch}**. Reason: ${baseBranchFallbackReason}.`;
    try {
      d.stmts.createKanbanCardComment.run(crypto.randomUUID(), card.id, 'Agent Hub', note);
      d.broadcast({ type: 'kanban_update', projectId: project.id });
    } catch (commentErr: unknown) {
      const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);
      console.warn(`[auto-commit] Failed to post base-branch fallback comment: ${msg}`);
    }
    console.warn(
      `[auto-commit] PR base branch override ignored for card ${card.id}: ${baseBranchFallbackReason}`,
    );
  }

  const changes = await checkWorktreeChanges(effectiveCwd);

  if (!changes.hasUncommitted && !changes.hasUnpushed) {
    console.log(
      `[auto-commit] Session ${sessionId} — skipping commit/push (no changes)${card ? ` [card: "${card.title}"]` : ''}`,
    );
    try {
      const { stdout: prOut } = await runGh(
        ['pr', 'view', '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'],
        effectiveCwd,
        15000,
        githubToken,
      );
      const existingPrUrl = prOut.trim();
      if (existingPrUrl) {
        console.log(
          `[auto-commit] Found existing open PR: ${existingPrUrl} — moving card to Review`,
        );
        await retargetExistingPrIfNeeded(
          existingPrUrl,
          resolvedBaseBranch,
          card,
          project,
          effectiveCwd,
          githubToken,
        );
        if (card) moveCardToReview(card, project, existingPrUrl);
        // Re-apply auto-merge intent in case the user flipped the toggle ON
        // and re-clicked "Create PR" against a branch with no new changes.
        // Idempotent on GitHub's side if already enabled.
        enableAutoMergeIfNeeded(
          existingPrUrl,
          project,
          options?.autoMergeOverride,
          effectiveCwd,
          githubToken,
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[auto-merge] Unexpected error enabling auto-merge: ${msg}`);
        });
        return { ok: true, prUrl: existingPrUrl };
      }
    } catch {
      // No open PR for this branch
    }
    return {
      ok: false,
      error: 'No local changes to publish and no open pull request for this branch.',
      code: 'nothing_to_publish',
    };
  }

  console.log(
    `[auto-commit] Session ${sessionId} — uncommitted: ${changes.hasUncommitted}, unpushed: ${changes.hasUnpushed}`,
  );

  let prLogStarted = false;
  const prLog = (text: string) => {
    prLogStarted = true;
    d.broadcast({ type: 'create_pr_log', sessionId, text });
  };

  try {
    prLog('## Publishing to GitHub\n');

    const session = d.stmts.getSession?.get(sessionId) as { name?: string } | undefined;
    const rawTitle = (card?.title ?? session?.name ?? '').trim();
    const commitTitle = rawTitle || 'Agent task completion';

    if (changes.hasUncommitted) {
      try {
        await ensureSessionWorktreeDependenciesInstalled(
          project.cwd,
          effectiveCwd,
          sessionInstallCommand(project),
        );
      } catch (installErr: unknown) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        console.error(`[auto-commit] Dependency install failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed', branch: changes.branch };
      }
      // Ensure git identity is configured (may be missing in shallow clones)
      try {
        await execAsync('git config user.name', { cwd: effectiveCwd });
      } catch {
        // Try to copy from the project's main repo, or fall back to defaults
        try {
          const { stdout: name } = await execAsync('git config user.name', { cwd: project.cwd });
          const { stdout: email } = await execAsync('git config user.email', { cwd: project.cwd });
          if (name.trim())
            await execAsync(`git config user.name ${JSON.stringify(name.trim())}`, {
              cwd: effectiveCwd,
            });
          if (email.trim())
            await execAsync(`git config user.email ${JSON.stringify(email.trim())}`, {
              cwd: effectiveCwd,
            });
        } catch {
          await execAsync('git config user.name "Agent Hub"', { cwd: effectiveCwd });
          await execAsync('git config user.email "agent@agent-hub.com"', { cwd: effectiveCwd });
        }
      }

      const commitBody = [
        card?.description ? `\n${card.description}` : null,
        `\nAgent: ${agent.name}`,
        card?.priority ? `Priority: ${card.priority}` : null,
        `\nCo-Authored-By: ${agent.name} <noreply@anthropic.com>`,
      ]
        .filter((line): line is string => line != null)
        .join('\n');

      prLog('$ git add -A\n');
      await execAsync('git add -A', { cwd: effectiveCwd });
      try {
        await runProjectPreCommitCommands(project, effectiveCwd, prLog);
      } catch (preErr: unknown) {
        const msg = preErr instanceof Error ? preErr.message : String(preErr);
        console.error(`[auto-commit] Pre-commit failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed', branch: changes.branch };
      }
      // Pre-commit commands may run formatters / fixers that write the tree; re-stage
      // so those edits are included in the commit (matches typical hook UX).
      prLog('$ git add -A\n');
      await execAsync('git add -A', { cwd: effectiveCwd });
      const fullMessage = truncateForGitCommitMessage(`${commitTitle}\n${commitBody}`);
      prLog('$ git commit\n');
      let commitResult: { code: number | null; stdout: string; stderr: string };
      try {
        commitResult = await spawnProcessStreaming('git', ['commit', '-m', fullMessage], {
          cwd: effectiveCwd,
          timeoutMs: PRECOMMIT_CMD_TIMEOUT_MS,
          onChunk: prLog,
          githubToken,
        });
      } catch (spawnErr: unknown) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        console.error(`[auto-commit] Commit failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed', branch: changes.branch };
      }
      if (commitResult.code !== 0) {
        const msg = formatSpawnFailure('git', commitResult);
        console.error(`[auto-commit] Commit failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed', branch: changes.branch };
      }
      console.log(`[auto-commit] Committed: ${commitTitle}`);
    } else {
      console.log(`[auto-commit] Agent already committed — skipping commit, will push + PR`);
    }

    prLog(`\n$ git push -u origin ${changes.branch}\n`);
    let pushResult: { code: number | null; stdout: string; stderr: string };
    try {
      pushResult = await spawnProcessStreaming('git', ['push', '-u', 'origin', changes.branch], {
        cwd: effectiveCwd,
        timeoutMs: 300_000,
        onChunk: prLog,
        githubToken,
      });
    } catch (pushErr: unknown) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.error(`[auto-commit] Push failed: ${msg}`);
      return { ok: false, error: msg, code: 'push_failed', branch: changes.branch };
    }
    if (pushResult.code !== 0) {
      const msg = formatSpawnFailure('git', pushResult);
      console.error(`[auto-commit] Push failed: ${msg}`);
      return { ok: false, error: msg, code: 'push_failed', branch: changes.branch };
    }
    console.log(`[auto-commit] Pushed branch ${changes.branch}`);

    const config = d.getConfig();
    const reviewer =
      agent.reviewer ||
      ((project as Record<string, unknown>).defaultReviewer as string | undefined) ||
      config.defaultReviewer;
    const validReviewer = reviewer && /^[a-zA-Z0-9_-]+$/.test(reviewer) ? reviewer : null;
    if (reviewer && !validReviewer) {
      console.warn(
        `[auto-commit] Invalid reviewer username "${reviewer}" — creating PR without reviewer`,
      );
    }

    const [commits, diffStat] = await Promise.all([
      collectCommits(effectiveCwd),
      collectDiffStat(effectiveCwd),
    ]);
    // Pass commits into buildPrTitle so the agent's actual commit subject(s)
    // win over the card / session title — see buildPrTitle JSDoc for why.
    // buildPrTitle only uses subjects; passing CommitInfo[] is fine since the
    // signature accepts both shapes.
    const prTitle = buildPrTitle(commitTitle, commits);
    const prBody = buildPrBody({
      card,
      agentName: agent.name,
      commits,
      diffStat,
    });

    const broadcastAndMove = async (prUrl: string) => {
      d.broadcast({
        type: 'auto_pr_created',
        sessionId,
        agentId,
        prUrl,
        cardTitle: card?.title || commitTitle,
      });

      // Persist a permanent "PR created" marker in the chat timeline as a
      // system-role message. This gives the user a timestamped receipt of the
      // action (manual click OR auto-PR at session end). Failure here is
      // non-fatal — the PR still exists and the auto_pr_created broadcast fires
      // regardless.
      try {
        let commitSha = '';
        try {
          const { stdout: shaOut } = await execAsync('git rev-parse HEAD', {
            cwd: effectiveCwd,
            timeout: 5000,
          });
          commitSha = shaOut.trim().substring(0, 12);
        } catch {
          /* commit SHA is best-effort — the marker is still useful without it */
        }
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;
        const msgId = crypto.randomUUID();
        const metadata = JSON.stringify({
          kind: 'pr_created',
          prUrl,
          prNumber,
          commitSha,
          commitTitle,
          cardId: card?.id ?? null,
          cardTitle: card?.title ?? null,
        });
        d.stmts.addMessage.run(
          msgId,
          sessionId,
          'system',
          'PR created from these changes',
          null,
          null,
          null,
          metadata,
        );
        const insertedMessage = (d.stmts.getMessageById?.get(msgId) as MessageRow | undefined) ?? {
          id: msgId,
          session_id: sessionId,
          role: 'system' as const,
          content: 'PR created from these changes',
          engine: null,
          model: null,
          attachments: null,
          metadata,
          created_at: new Date().toISOString(),
        };
        d.broadcast({ type: 'message_added', sessionId, message: insertedMessage });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[auto-commit] Failed to persist PR-created marker: ${msg}`);
      }

      // Reconciliation: ensure card has pr_url linked
      if (card && !card.pr_url) {
        try {
          d.stmts.setCardPrUrl.run(prUrl, card.id);
          console.log(`[auto-commit] Linked PR URL to card "${card.title}": ${prUrl}`);
        } catch (_e: unknown) {
          /* non-critical */
        }
      }

      // Move the card to Review for visibility. The Reviewer agent will be
      // dispatched by the GitHub webhook handler when the PR opens/syncs.
      if (card) moveCardToReview(card, project, prUrl);

      // Project + dashboard activity feeds (kanban Reviews panel, org dashboard).
      try {
        const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumMatch ? parseInt(prNumMatch[1], 10) : null;
        const inserted = d.stmts.createPrCreationLog.run(
          crypto.randomUUID(),
          project.id,
          card?.id ?? null,
          sessionId,
          prUrl,
          prNumber,
          prTitle,
          agent.name || 'Agent',
        );
        if (inserted.changes > 0) {
          d.broadcast({ type: 'kanban_update', projectId: project.id });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[auto-commit] Failed to persist PR creation activity log: ${msg}`);
      }

      // Fire-and-forget: enable GitHub native auto-merge if the project or
      // per-PR override requests it. Failure here never blocks PR creation.
      enableAutoMergeIfNeeded(
        prUrl,
        project,
        options?.autoMergeOverride,
        effectiveCwd,
        githubToken,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[auto-merge] Unexpected error enabling auto-merge: ${msg}`);
      });
    };

    // ── Pre-check: existing open PR for this branch ───────────────────
    //
    // Resolve-comment / review-feedback flows push additional commits to
    // a PR branch that already has an open PR. Calling `gh pr create`
    // against a branch that already has an open PR returns a non-zero
    // exit which is then handled by the catch-block below — but only
    // when the gh error message includes the existing PR URL on stdout
    // or stderr. That format has drifted across `gh` versions and is
    // not contractual. Worse, when a fresh resolve session is spawned
    // on a NEW worktree branch, `gh pr create` SUCCEEDS and opens a
    // duplicate PR for the same logical change (one new PR per review
    // round). Pre-checking via `gh pr view --json url,state` is the
    // authoritative source of truth and removes both failure modes.
    //
    // `gh pr view <branch>` exits non-zero when the branch has no PR,
    // which we treat as "no existing PR — fall through to create".
    let existingPrForBranch: string | null = null;
    try {
      prLog('\n$ gh pr view (check for existing open PR) …\n');
      const { stdout: preCheckOut } = await runGhStreamed(
        [
          'pr',
          'view',
          changes.branch,
          '--json',
          'url,state',
          '--jq',
          'select(.state == "OPEN") | .url',
        ],
        effectiveCwd,
        15000,
        prLog,
        githubToken,
      );
      const url = preCheckOut.trim();
      if (url && /^https:\/\/github\.com\/[^\s]+\/pull\/\d+/.test(url)) {
        existingPrForBranch = url;
      }
    } catch {
      // No open PR for this branch — proceed with `gh pr create`.
    }

    if (existingPrForBranch) {
      console.log(
        `[auto-commit] Existing open PR for branch "${changes.branch}": ${existingPrForBranch} — pushing additional commits without opening a new PR`,
      );
      await retargetExistingPrIfNeeded(
        existingPrForBranch,
        resolvedBaseBranch,
        card,
        project,
        effectiveCwd,
        githubToken,
      );
      await broadcastAndMove(existingPrForBranch);
      return { ok: true, prUrl: existingPrForBranch };
    }

    // ── Empty-diff guard ───────────────────────────────────────────────
    //
    // `checkWorktreeChanges` (line ~1545) only measures commits against the
    // branch's upstream or repo default branch. That misses the case where
    // `resolvedBaseBranch` is a feature / session / epic branch that already
    // contains every commit on the head branch — `gh pr create` would then
    // bounce off GitHub with `GraphQL: No commits between <head> and <base>`,
    // which the catch-block below surfaces as the noisy `pr_failed` code.
    //
    // Counted via `git rev-list --count <base-ref>..origin/<head>` AFTER the
    // push above, so both refs exist on `origin`. If we can't resolve a
    // base ref locally, fall through and let `gh` decide — preserve the
    // current loud-fail behavior rather than silently skip.
    const headRef = `origin/${changes.branch}`;
    let diffBaseRef: string | null = null;
    if (resolvedBaseBranch) {
      // Branch was already validated as existing on `origin` at the
      // `git ls-remote --heads origin <base>` check above. Make sure we have
      // it locally before diffing — `git fetch` is a no-op if up-to-date.
      try {
        await execFileAsync('git', ['fetch', '--no-tags', 'origin', resolvedBaseBranch], {
          cwd: effectiveCwd,
          timeout: 30_000,
          env: autoGitChildEnv(githubToken),
        });
        diffBaseRef = `origin/${resolvedBaseBranch}`;
      } catch (fetchErr: unknown) {
        console.warn(
          `[auto-commit] Empty-diff guard: failed to fetch origin/${resolvedBaseBranch}: ${
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          } — skipping pre-check, letting gh pr create decide`,
        );
      }
    } else {
      const defaultBranch = await resolveDefaultBranch(effectiveCwd);
      if (defaultBranch) {
        try {
          await execFileAsync('git', ['fetch', '--no-tags', 'origin', defaultBranch], {
            cwd: effectiveCwd,
            timeout: 30_000,
            env: autoGitChildEnv(githubToken),
          });
          diffBaseRef = `origin/${defaultBranch}`;
        } catch (fetchErr: unknown) {
          console.warn(
            `[auto-commit] Empty-diff guard: failed to fetch origin/${defaultBranch}: ${
              fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
            } — skipping pre-check, letting gh pr create decide`,
          );
        }
      }
    }

    if (diffBaseRef) {
      try {
        const { stdout: countOut } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${diffBaseRef}..${headRef}`],
          { cwd: effectiveCwd, timeout: 15_000 },
        );
        const aheadCount = parseInt(countOut.trim(), 10);
        if (Number.isFinite(aheadCount) && aheadCount === 0) {
          const baseLabel = resolvedBaseBranch
            ? `\`${resolvedBaseBranch}\``
            : `the default branch (\`${diffBaseRef.replace(/^origin\//, '')}\`)`;
          const msg = `Branch \`${changes.branch}\` has no commits ahead of ${baseLabel}; skipping \`gh pr create\` (would have failed with "No commits between …").`;
          console.log(`[auto-commit] ${msg}`);
          prLog(`\n${msg}\n`);
          return {
            ok: false,
            error: msg,
            code: 'no_diff_vs_base',
            branch: changes.branch,
          };
        }
      } catch (countErr: unknown) {
        console.warn(
          `[auto-commit] Empty-diff guard: rev-list ${diffBaseRef}..${headRef} failed: ${
            countErr instanceof Error ? countErr.message : String(countErr)
          } — letting gh pr create decide`,
        );
      }
    }

    try {
      const createArgs = [
        'pr',
        'create',
        '--head',
        changes.branch,
        '--title',
        prTitle,
        '--body',
        prBody,
      ];
      if (resolvedBaseBranch) {
        createArgs.push('--base', resolvedBaseBranch);
      }
      if (validReviewer) {
        createArgs.push('--reviewer', validReviewer);
      }
      prLog('\n$ gh pr create …\n');
      const { stdout: prOutput } = await runGhStreamed(
        createArgs,
        effectiveCwd,
        30000,
        prLog,
        githubToken,
      );
      console.log(`[auto-commit] PR created: ${prOutput.trim()}`);

      const prUrl = prOutput.match(/https:\/\/github\.com\/.+\/pull\/\d+/)?.[0] || prOutput.trim();
      await broadcastAndMove(prUrl);
      return { ok: true, prUrl };
    } catch (prErr: unknown) {
      const errMsg = prErr instanceof Error ? prErr.message : String(prErr);
      const existingMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (existingMatch) {
        const prUrl = existingMatch[0];
        console.log(`[auto-commit] PR already exists: ${prUrl} — continuing flow`);
        await broadcastAndMove(prUrl);
        return { ok: true, prUrl };
      }

      console.error(`[auto-commit] PR creation failed: ${errMsg}`);
      // Fallback: try to discover PR by branch name
      try {
        prLog('\n$ gh pr view (discover open PR) …\n');
        const { stdout: prDiscovery } = await runGhStreamed(
          [
            'pr',
            'view',
            changes.branch,
            '--json',
            'url,state',
            '--jq',
            'select(.state == "OPEN") | .url',
          ],
          effectiveCwd,
          15000,
          prLog,
          githubToken,
        );
        const discoveredUrl = prDiscovery.trim();
        if (discoveredUrl) {
          console.log(`[auto-commit] Discovered PR by branch name: ${discoveredUrl}`);
          await broadcastAndMove(discoveredUrl);
          return { ok: true, prUrl: discoveredUrl };
        }
      } catch {
        // No PR found by branch name either
      }
      return { ok: false, error: errMsg, code: 'pr_failed', branch: changes.branch };
    }
  } finally {
    if (prLogStarted) {
      d.broadcast({ type: 'create_pr_log_done', sessionId });
    }
  }
}

// ─── Auto-PR failure surfacing ─────────────────────────────────────
//
// `commitPushAndCreatePR` historically only logged failures to
// `console.error`. For the **autonomous** and **ad-hoc-with-existing-PR**
// paths nothing reaches the UI, so a session that fails to push (typical
// cause: push rejected because the remote branch is ahead — see
// `troubleshooting-auto-commit-push-rejected-remote-branch-ahead`) looks
// like a session that finished normally, with no PR and no explanation.
//
// `persistAndBroadcastPrFailure` writes a single durable system-role
// message into the session timeline (so the failure shows up in the chat
// transcript, in the same place users already look for the PR-created
// banner) and broadcasts `auto_pr_failed` so the App can also toast it.
// Failure-of-the-failure-logger is intentionally swallowed: we already
// failed once and adding a second failure path that aborts the session
// teardown would just make the original symptom worse.
async function persistAndBroadcastPrFailure(args: {
  sessionId: string;
  agentId: string;
  agentName: string;
  card: KanbanCardRow | undefined;
  outcome: Extract<CommitPushPrResult, { ok: false }>;
}): Promise<void> {
  const { sessionId, agentId, agentName, card, outcome } = args;
  const d = getDeps();
  try {
    const human = humanizeCommitPrFailure(outcome);
    const metadata = JSON.stringify({
      kind: 'pr_failed',
      code: outcome.code,
      error: outcome.error,
      branch: outcome.branch ?? null,
      cardId: card?.id ?? null,
      cardTitle: card?.title ?? null,
      agentName,
    });
    const content = `Auto-PR failed (${outcome.code}): ${human}`;

    let inserted: MessageRow | undefined;
    try {
      const msgId = crypto.randomUUID();
      d.stmts.addMessage.run(msgId, sessionId, 'system', content, null, null, null, metadata);
      inserted = (d.stmts.getMessageById?.get(msgId) as MessageRow | undefined) ?? {
        id: msgId,
        session_id: sessionId,
        role: 'system' as const,
        content,
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-commit] Failed to persist pr_failed marker: ${msg}`);
    }
    if (inserted) {
      d.broadcast({ type: 'message_added', sessionId, message: inserted });
    }
    d.broadcast({
      type: 'auto_pr_failed',
      sessionId,
      agentId,
      code: outcome.code,
      error: outcome.error,
      branch: outcome.branch ?? null,
      cardId: card?.id ?? null,
      cardTitle: card?.title ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-commit] persistAndBroadcastPrFailure unexpected error: ${msg}`);
  }
}

// ─── Auto-commit & PR on agent completion ───────────────────────────

export async function autoCommitAndPR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  _finalContent: string,
): Promise<void> {
  const d = getDeps();
  try {
    // Tasks-only projects: no GitHub repo configured means no PR lifecycle.
    // Make this explicit at the top so the no-GitHub case is obvious from
    // a single read. Downstream checks (`effectiveCwd === project.cwd` and
    // `git remote -v`) would also reject these, but only after spending
    // time walking through worktree / card / ad-hoc branching.
    if (!project.githubRepo) {
      console.log(
        `[auto-commit] Session ${sessionId} — skipping (project has no githubRepo, tasks-only)`,
      );
      return;
    }

    if (agent.role === 'intake') {
      console.log(`[auto-commit] Session ${sessionId} — skipping (intake agent, no PR)`);
      return;
    }

    // Reviewer sessions exist to review existing PRs — they never author new
    // PRs, and the "Create PR" banner / `changes_ready` broadcast is never
    // appropriate for them. Skip before any worktree / PR-discovery work so
    // that even if a reviewer incidentally touched files, we don't surface a
    // creation prompt on the client.
    if (agent.role === 'reviewer') {
      console.log(`[auto-commit] Session ${sessionId} — skipping (reviewer agent, no PR)`);
      return;
    }

    if (effectiveCwd === project.cwd) {
      console.log(`[auto-commit] Session ${sessionId} — skipping (not a worktree)`);
      return;
    }

    try {
      await execAsync('git remote -v', { cwd: effectiveCwd });
    } catch {
      console.log(`[auto-commit] Session ${sessionId} — skipping (no git remote)`);
      return;
    }

    const card = d.stmts.getKanbanCardBySession?.get(sessionId) as KanbanCardRow | undefined;

    // A card being linked via `session_id` is NOT sufficient to force the
    // autonomous auto-PR path. Users/agents may manually link a card to a
    // session mid-stream for UI cross-reference or to attach a PR URL later.
    // Only rows dispatched from `autonomous.ts` set `dispatched_by_autonomous`
    // (via `markCardDispatchedByAutonomous`). Legacy DBs are backfilled from
    // the historical `autonomous_iterations` counter and autonomous epics —
    // not raw `epic_id`.
    const isAutonomousCard = !!card && Number(card.dispatched_by_autonomous) === 1;

    // Ad-hoc sessions (no card, OR a card not dispatched by the autonomous
    // system): two sub-cases.
    //   1. Existing PR on this branch → agent was likely fixing CI or a
    //      reviewer comment. Push (and commit if needed) so GitHub sees the
    //      fix. No new PR is opened.
    //   2. No existing PR → broadcast `changes_ready` so the "Create PR"
    //      button surfaces in the UI for the user to decide.
    // A manually-linked (non-autonomous) card still goes through this path:
    // `manualCommitAndPR` (the button handler) re-queries by sessionId and
    // will attach the PR URL to the card when the user clicks.
    if (!isAutonomousCard) {
      const changes = await checkWorktreeChanges(effectiveCwd);
      if (!changes.hasUncommitted && !changes.hasUnpushed) {
        return;
      }

      // Does an open PR already exist for this branch?
      let existingPrUrl: string | null = null;
      const adHocToken = await resolveAutoGitGithubToken(sessionId, d.getConfig());
      try {
        const { stdout: prOut } = await runGh(
          ['pr', 'view', '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'],
          effectiveCwd,
          15000,
          adHocToken,
        );
        existingPrUrl = prOut.trim() || null;
      } catch {
        // No open PR for this branch — fall through to the banner path.
      }

      if (existingPrUrl) {
        console.log(
          `[auto-commit] Session ${sessionId} — ad-hoc with existing PR (${existingPrUrl}), pushing fix`,
        );
        // Reuse the card-driven path with no card: it commits (if needed),
        // pushes the branch, and gracefully handles "PR already exists" by
        // broadcasting `auto_pr_created` with the existing URL via the catch
        // branch in commitPushAndCreatePR. No new PR is opened.
        const prOutcome = await commitPushAndCreatePR(
          sessionId,
          agentId,
          project,
          agent,
          effectiveCwd,
          undefined,
        );
        if (prOutcome.ok) {
          d.stmts.clearSessionChangesReady.run(sessionId);
        } else if (prOutcome.code === 'nothing_to_publish') {
          // Benign no-op: a clean worktree with no open PR is a normal
          // terminal state for sessions that intentionally do no work
          // (research/Q&A turns, already-done cards). Log at INFO, not
          // ERROR, so it stops triggering the tool-error classifier.
          console.log(
            `[auto-commit] Ad-hoc push/PR path: nothing to publish (clean worktree, no open PR) — ${prOutcome.error}`,
          );
        } else {
          console.error(
            `[auto-commit] Ad-hoc push/PR path failed (${prOutcome.code}): ${prOutcome.error}`,
          );
          await persistAndBroadcastPrFailure({
            sessionId,
            agentId,
            agentName: agent.name || 'Agent',
            card: undefined,
            outcome: prOutcome,
          });
        }
        return;
      }

      console.log(
        `[auto-commit] Session ${sessionId} — ad-hoc session with changes, broadcasting changes_ready`,
      );
      try {
        await ensureSessionWorktreeDependenciesInstalled(
          project.cwd,
          effectiveCwd,
          sessionInstallCommand(project),
        );
      } catch (installErr: unknown) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        console.error(
          `[auto-commit] Dependency install failed before changes_ready (session ${sessionId}): ${msg}`,
        );
        // Still broadcast — operator may fix deps manually; Create PR will surface commit errors.
      }
      const changesReadyData = {
        agentId,
        branch: changes.branch,
        hasUncommitted: changes.hasUncommitted,
        hasUnpushed: changes.hasUnpushed,
      };
      d.stmts.updateSessionChangesReady.run(JSON.stringify(changesReadyData), sessionId);
      // Enrich with display names so mobile push recipients get a meaningful
      // title/body without a follow-up API call. `getSession` may be absent
      // under test mocks — tolerate its absence.
      let sessionName: string | undefined;
      try {
        const sessionRow = d.stmts.getSession?.get?.(sessionId) as { name?: string } | undefined;
        sessionName = sessionRow?.name;
      } catch {
        /* best-effort enrichment */
      }
      d.broadcast({
        type: 'changes_ready',
        sessionId,
        agentName: agent.name,
        sessionName,
        ...changesReadyData,
      });
      return;
    }

    // Autonomous/card-driven sessions (card actually dispatched by the
    // autonomous system): commit, push, create PR, move card to Review. The
    // Reviewer agent is dispatched separately by the GitHub webhook handler
    // when the PR opens or syncs.
    const autonomousOutcome = await commitPushAndCreatePR(
      sessionId,
      agentId,
      project,
      agent,
      effectiveCwd,
      card,
    );
    if (!autonomousOutcome.ok) {
      if (autonomousOutcome.code === 'nothing_to_publish') {
        // Benign no-op: an autonomous-dispatched session can finish without
        // producing changes (e.g. picked up a card and discovered the work
        // was already shipped, then closed it via <agenthub:close-card>;
        // research/Q&A turns; no-op investigations). The function contract
        // already distinguishes this case via its own code — log at INFO so
        // it stops feeding the tool-error classifier as an ERROR.
        console.log(
          `[auto-commit] Autonomous PR path: nothing to publish (clean worktree, no open PR) — ${autonomousOutcome.error}`,
        );
      } else {
        console.error(
          `[auto-commit] Autonomous PR path failed (${autonomousOutcome.code}): ${autonomousOutcome.error}`,
        );
        await persistAndBroadcastPrFailure({
          sessionId,
          agentId,
          agentName: agent.name || 'Agent',
          card,
          outcome: autonomousOutcome,
        });
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auto-commit] Failed: ${msg}`);
  }
}

// ─── Title sanitization ─────────────────────────────────────────────

/**
 * Check if a string looks like raw cron/heartbeat output rather than a clean title.
 * Raw output typically contains newlines, status symbols, timestamps, or markdown headers.
 */
export function isGarbageTitle(title: string): boolean {
  if (title.includes('\n')) return true;
  if (/^[✓✗⚠●]/.test(title)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(title)) return true;
  if (/^#{1,3}\s/.test(title)) return true;
  if (title.length > 120) return true;
  return false;
}

/**
 * Derive a clean PR title from the git log when the session name is unusable.
 * Falls back to a generic agent-based title.
 */
async function deriveCleanTitle(cwd: string, agentName: string): Promise<string> {
  try {
    // Use the most recent commit message on this branch vs main
    const { stdout } = await execAsync(
      'git log main..HEAD --format=%s --reverse 2>/dev/null | head -1',
      { cwd, timeout: 10000 },
    );
    const firstCommitMsg = stdout.trim();
    if (firstCommitMsg && !isGarbageTitle(firstCommitMsg)) {
      return firstCommitMsg.length > 70 ? firstCommitMsg.substring(0, 67) + '...' : firstCommitMsg;
    }
  } catch {
    // fall through
  }

  try {
    // Fall back to diffstat summary
    const { stdout } = await execAsync('git diff --stat main...HEAD 2>/dev/null | tail -1', {
      cwd,
      timeout: 10000,
    });
    const stat = stdout.trim();
    if (stat) {
      return `${agentName}: ${stat}`.substring(0, 70);
    }
  } catch {
    // fall through
  }

  return `${agentName}: ad-hoc changes`;
}

// ─── Manual commit & PR (triggered by user from UI) ─────────────────

export async function manualCommitAndPR(
  sessionId: string,
  agentId: string,
  project: Project,
  agent: Agent,
  effectiveCwd: string,
  options: { title?: string; autoMerge?: boolean },
): Promise<ManualPrResult> {
  const d = getDeps();

  // Tasks-only projects have no GitHub repo and no PR lifecycle. The "Create
  // PR" button should never reach this code path (the UI hides it), but a
  // direct API hit must fail fast with a clear reason.
  if (!project.githubRepo) {
    return {
      ok: false,
      error: 'This project is not connected to a GitHub repository.',
      code: 'no_github_repo',
    };
  }

  const board = d.stmts.getKanbanBoard?.get(project.id) as { id: string } | undefined;
  if (!board) {
    console.error(`[manual-pr] No kanban board found for project ${project.id}`);
    return {
      ok: false,
      error: 'No kanban board is configured for this project.',
      code: 'no_board',
    };
  }

  // Reuse an existing card already linked to this session, if any. Without
  // this check we would unconditionally `createKanbanCard.run()` below —
  // producing a duplicate card in the Review column while the original
  // (autonomous-dispatched ticket, bug report, or user-linked card) stays
  // behind in its current column. That's the "two cards per unit of work"
  // bug users report when their PR enters review.
  let card = d.stmts.getKanbanCardBySession?.get(sessionId) as KanbanCardRow | undefined;
  let cardId: string;

  if (card) {
    cardId = card.id;
    console.log(
      `[manual-pr] Reusing existing card "${card.title}" already linked to session ${sessionId} (skipping duplicate create)`,
    );
  } else {
    // Create a kanban card for tracking
    const session = d.stmts.getSession?.get(sessionId) as { name?: string } | undefined;
    const rawName = options.title || session?.name || '';
    const cardTitle =
      rawName && !isGarbageTitle(rawName)
        ? rawName
        : await deriveCleanTitle(effectiveCwd, agent.name || 'Agent');
    cardId = crypto.randomUUID();

    const cols = d.stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>;
    const inProgressCol = cols.find((c) => c.name === 'In Progress');
    const targetCol = inProgressCol || cols[0];
    if (!targetCol) {
      console.error(`[manual-pr] No columns found on board`);
      return {
        ok: false,
        error: 'The kanban board has no columns — cannot create a tracking card.',
        code: 'no_columns',
      };
    }

    // Build a rich description from session messages + git diff stat
    const messages = d.stmts.getMessages.all(sessionId) as MessageRow[];
    let diffStat = '';
    try {
      const { stdout } = await execAsync(
        'git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat main...HEAD',
        {
          cwd: effectiveCwd,
          timeout: 10000,
        },
      );
      diffStat = stdout;
    } catch {
      // diff stat is optional — proceed without it
    }
    const cardDescription = buildCardDescription(messages, diffStat);

    // createKanbanCard params: (id, column_id, board_id, title, description, priority,
    //   assignee, labels, session_id, github_issue_url, created_by, assign_model, position)
    d.stmts.createKanbanCard.run(
      cardId,
      targetCol.id,
      board.id,
      cardTitle,
      cardDescription,
      'medium',
      agent.name || '',
      '',
      sessionId,
      '',
      agent.name || '',
      null,
      0,
    );
    console.log(`[manual-pr] Created card "${cardTitle}" and linked to session ${sessionId}`);
    card = d.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
  }

  const result = await commitPushAndCreatePR(
    sessionId,
    agentId,
    project,
    agent,
    effectiveCwd,
    card,
    { autoMergeOverride: options.autoMerge },
  );

  if (result.ok) {
    d.broadcast({ type: 'kanban_update', projectId: project.id });
    return { ok: true, prUrl: result.prUrl, cardId };
  }

  return {
    ok: false,
    error: humanizeCommitPrFailure(result),
    code: result.code,
  };
}
