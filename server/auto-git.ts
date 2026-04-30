import crypto from 'crypto';
import path from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type {
  Stmts,
  Project,
  Agent,
  KanbanCardRow,
  AppConfig,
  BroadcastFn,
  MessageRow,
} from './types.js';
import { resolveShouldAutoMerge } from './auto-merge.js';
import { resolveSpawnPath } from './shell-path.js';

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
 * Child env for `git` / shell steps in this module. Uses the same PATH merge as
 * `buildSpawnEnv` (login shell + fallbacks) without importing `config.ts` — that
 * module has import-time side effects that break unit tests which mock `fs`.
 */
function autoGitChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: resolveSpawnPath(process.env.PATH) };
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
  opts: { cwd: string; timeoutMs: number; onChunk?: SpawnChunkHandler; maxOutputBytes?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const maxOut = opts.maxOutputBytes ?? STREAM_OUTPUT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: autoGitChildEnv(),
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
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('gh', args, { cwd, timeout });
}

/** Same argv safety as `runGh`, with optional live stdout/stderr for the UI. */
async function runGhStreamed(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChunk?: SpawnChunkHandler,
): Promise<{ stdout: string; stderr: string }> {
  if (!onChunk) {
    return runGh(args, cwd, timeoutMs);
  }
  const r = await spawnProcessStreaming('gh', args, { cwd, timeoutMs, onChunk });
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
  skillContent?: string;
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
        const raw = readFileSync(skillMd, 'utf-8');
        return { skillContent: raw, skillName, userArgs };
      }
    }

    const mdPath = skillName.endsWith('.md')
      ? path.join(skillsDir, skillName)
      : path.join(skillsDir, skillName + '.md');
    if (existsSync(mdPath) && !statSync(mdPath).isDirectory()) {
      const raw = readFileSync(mdPath, 'utf-8');
      return { skillContent: raw, skillName: skillName.replace('.md', ''), userArgs };
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
 * Pick the most descriptive commit subject from a branch's commit list to use
 * as the PR title. Returns null if every commit looks generic / non-descriptive
 * (in which case the caller should fall back to the card / session title).
 *
 * Commits are expected newest-first (the order `git log main..HEAD` returns).
 * We prefer the newest non-generic subject — it usually reflects the final
 * shape of the change after any fixups.
 */
export function pickPrTitleFromCommits(commits: string[] | undefined): string | null {
  if (!commits) return null;
  for (const raw of commits) {
    const subject = (raw ?? '').trim();
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
export function buildPrTitle(rawTitle: string, commits?: string[]): string {
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
  commits?: string[];
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
  const commitList = (commits ?? []).map((c) => c.trim()).filter(Boolean);
  const cardDescription = card?.description?.trim() || '';
  const commitDrivenSummary = commitList.length > 0;
  let summary: string;
  if (commitList.length === 1) {
    summary = commitList[0];
  } else if (commitList.length > 1) {
    // For multi-commit branches the bulleted ## Commits section below renders
    // the full list; here in Summary we surface a one-line lede so the PR is
    // skimmable. Prefer the most recent (newest-first) descriptive subject.
    summary = pickPrTitleFromCommits(commitList) ?? commitList[0];
  } else if (cardDescription) {
    summary = cardDescription;
  } else {
    summary = `Task completed by ${agentName}.`;
  }
  sections.push('## Summary');
  sections.push(summary);

  // Commits — only list when there's more than one, otherwise the single
  // commit subject is already the summary and listing it is noise.
  if (commitList.length > 1) {
    sections.push('');
    sections.push('## Commits');
    const MAX_COMMITS = 20;
    const shown = commitList.slice(0, MAX_COMMITS);
    for (const c of shown) sections.push(`- ${c}`);
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
  | { ok: false; error: string; code: CommitPushPrFailureCode };

export type CommitPushPrFailureCode =
  | 'nothing_to_publish'
  | 'commit_failed'
  | 'push_failed'
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
    default:
      return r.error;
  }
}

async function enableAutoMergeIfNeeded(
  prUrl: string,
  project: Project,
  override: boolean | undefined,
  cwd: string,
): Promise<void> {
  if (!resolveShouldAutoMerge(override, project.githubWorkflow)) return;
  try {
    await runGh(['pr', 'merge', '--auto', '--squash', prUrl], cwd, 15000);
    console.log(`[auto-merge] Enabled GitHub native auto-merge for ${prUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-merge] Failed to enable auto-merge for ${prUrl}: ${msg}`);
  }
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
      );
      const existingPrUrl = prOut.trim();
      if (existingPrUrl) {
        console.log(
          `[auto-commit] Found existing open PR: ${existingPrUrl} — moving card to Review`,
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
        return { ok: false, error: msg, code: 'commit_failed' };
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
        });
      } catch (spawnErr: unknown) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        console.error(`[auto-commit] Commit failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed' };
      }
      if (commitResult.code !== 0) {
        const msg = formatSpawnFailure('git', commitResult);
        console.error(`[auto-commit] Commit failed: ${msg}`);
        return { ok: false, error: msg, code: 'commit_failed' };
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
      });
    } catch (pushErr: unknown) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.error(`[auto-commit] Push failed: ${msg}`);
      return { ok: false, error: msg, code: 'push_failed' };
    }
    if (pushResult.code !== 0) {
      const msg = formatSpawnFailure('git', pushResult);
      console.error(`[auto-commit] Push failed: ${msg}`);
      return { ok: false, error: msg, code: 'push_failed' };
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
      collectCommitSubjects(effectiveCwd),
      collectDiffStat(effectiveCwd),
    ]);
    // Pass commits into buildPrTitle so the agent's actual commit subject(s)
    // win over the card / session title — see buildPrTitle JSDoc for why.
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
      enableAutoMergeIfNeeded(prUrl, project, options?.autoMergeOverride, effectiveCwd).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[auto-merge] Unexpected error enabling auto-merge: ${msg}`);
        },
      );
    };

    // ── PR base-branch override ─────────────────────────────────────
    //
    // Cards may override the PR base via `card.pr_base_branch` (e.g. for
    // stacked PRs). When set, validate the branch still exists on `origin`
    // before passing it to `gh pr create --base`. If it doesn't, fall back
    // to the repo default and post an explanatory comment on the card so
    // the user can see why their override didn't apply.
    let resolvedBaseBranch: string | null = null;
    let baseBranchFellBack = false;
    let baseBranchFallbackReason: string | null = null;
    const requestedBase = card?.pr_base_branch?.trim();
    // Defensive re-validation of the persisted value before we hand it to
    // `gh`. The PUT route already enforces this regex, but we don't want a
    // hand-edited DB row to escape into a spawned argv.
    const isSafeBranch = (s: string) => /^[A-Za-z0-9._/-]+$/.test(s);

    if (requestedBase && isSafeBranch(requestedBase)) {
      try {
        const { stdout: lsOut } = await execAsync(
          `git ls-remote --heads origin ${JSON.stringify(requestedBase)}`,
          { cwd: effectiveCwd, timeout: 10_000 },
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
      const { stdout: prOutput } = await runGhStreamed(createArgs, effectiveCwd, 30000, prLog);
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
      return { ok: false, error: errMsg, code: 'pr_failed' };
    }
  } finally {
    if (prLogStarted) {
      d.broadcast({ type: 'create_pr_log_done', sessionId });
    }
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
    // (via `incrementCardIterations`). Legacy DBs are backfilled from
    // `autonomous_iterations` and autonomous epics — not raw `epic_id`.
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
      try {
        const { stdout: prOut } = await runGh(
          ['pr', 'view', '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'],
          effectiveCwd,
          15000,
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
        }
        return;
      }

      console.log(
        `[auto-commit] Session ${sessionId} — ad-hoc session with changes, broadcasting changes_ready`,
      );
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
