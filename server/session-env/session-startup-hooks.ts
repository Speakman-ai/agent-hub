/**
 * Project session startup hooks — background shell commands after every
 * SessionEnv boot, without blocking `ensure()` / chat.
 *
 * Config lives on the Hub project (`sessionStartupCommands`). Commands run
 * via {@link SessionEnv.spawn} with cwd at the session worktree root (the same
 * workspace chat, terminal, and preview use — guest `/workspace` for
 * env-owned / container envs, host worktree path for the host adapter). Status
 * is kept in-memory for the enriched prompt / spawn env and mirrored to
 * `.agent-hub-runtime/session-startup.json` inside the session worktree so the
 * agent can `cat` it mid-turn.
 */
import { randomUUID } from 'crypto';
import type { SessionEnv } from './session-env.js';
import type { SessionWorktreeIo } from './worktree-io.js';

/** Progress-panel / progress_step label. */
export const SESSION_STARTUP_STEP = 'Session setup';

/** Worktree-relative status file (guest path: `/workspace/<this>`). */
export const SESSION_STARTUP_STATUS_REL = '.agent-hub-runtime/session-startup.json';

/** Guest-absolute path agents should prefer when env-owned. */
export const SESSION_STARTUP_STATUS_GUEST_ABS = `/workspace/${SESSION_STARTUP_STATUS_REL}`;

/** Per-command wall-clock cap (15 min). */
export const SESSION_STARTUP_COMMAND_TIMEOUT_MS = 900_000;

/** Cap captured stdout+stderr the same way worktree IO / Finalize do. */
const STARTUP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const DETAIL_CAP = 4_000;

export type SessionStartupRunStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
export type SessionStartupCommandStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface SessionStartupCommandState {
  cmd: string;
  status: SessionStartupCommandStatus;
  exitCode: number | null;
  detail: string | null;
}

export interface SessionStartupStatus {
  status: SessionStartupRunStatus;
  startedAt: number;
  finishedAt: number | null;
  commands: SessionStartupCommandState[];
  bootId: string;
  /** Absolute or worktree-relative path the agent should read. */
  statusPath: string;
}

const statusBySession = new Map<string, SessionStartupStatus>();

export function getSessionStartupStatus(sessionId: string): SessionStartupStatus | null {
  return statusBySession.get(sessionId) ?? null;
}

export function clearSessionStartupStatus(sessionId: string): void {
  statusBySession.delete(sessionId);
}

/** Test helper — wipe the in-memory registry. */
export function __resetSessionStartupStatusForTests(): void {
  statusBySession.clear();
}

export function normalizeSessionStartupCommands(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getProjectSessionStartupCommands(project: {
  sessionStartupCommands?: unknown;
}): string[] {
  return normalizeSessionStartupCommands(project.sessionStartupCommands);
}

function truncateDetail(stdout: string, stderr: string): string | null {
  const merged = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').trim();
  if (!merged) return null;
  if (merged.length <= DETAIL_CAP) return merged;
  return `…${merged.slice(-DETAIL_CAP)}`;
}

/** Compact failure text for Progress panel / WS (command + exit + log tail). */
export function formatSessionStartupProgressDetail(
  status: SessionStartupStatus,
): string | undefined {
  const failed = status.commands.find((c) => c.status === 'failed');
  if (!failed) return undefined;
  const header = `$ ${failed.cmd}` + (failed.exitCode != null ? ` (exit ${failed.exitCode})` : '');
  const body = failed.detail?.trim();
  return body ? `${header}\n${body}` : header;
}

function statusPathForEnv(env: SessionEnv): string {
  return env.worktreeIo.sharing === 'env-owned'
    ? SESSION_STARTUP_STATUS_GUEST_ABS
    : SESSION_STARTUP_STATUS_REL;
}

/**
 * Run one startup command in the session workspace via {@link SessionEnv.spawn}.
 *
 * Important: do **not** use `worktreeIo.exec` here. On host-shared container
 * envs that path runs on the Hub host at the seed worktree; chat/terminal/
 * preview use `spawn` inside the env (`/workspace`). Startup must match.
 */
export async function runStartupCommandInSessionWorkspace(
  env: SessionEnv,
  command: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = opts.timeoutMs ?? SESSION_STARTUP_COMMAND_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? STARTUP_OUTPUT_MAX_BYTES;
  const proc = env.spawn(command, {
    cwd: '.',
    name: `session-startup:${command.slice(0, 48)}`,
  });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overLimit = false;

  const append = (kind: 'stdout' | 'stderr', chunk: string) => {
    const n = Buffer.byteLength(chunk, 'utf8');
    if (kind === 'stdout') {
      stdoutBytes += n;
      if (stdoutBytes <= maxBytes) stdout += chunk;
    } else {
      stderrBytes += n;
      if (stderrBytes <= maxBytes) stderr += chunk;
    }
    if (!overLimit && stdoutBytes + stderrBytes > maxBytes) {
      overLimit = true;
      proc.kill('SIGKILL');
    }
  };
  proc.onStdout((chunk) => append('stdout', chunk));
  proc.onStderr((chunk) => append('stderr', chunk));

  let onAbort: (() => void) | undefined;
  try {
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Session startup command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      timer.unref?.();

      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          proc.kill('SIGKILL');
          reject(new Error('Session startup aborted'));
          return;
        }
        onAbort = () => {
          clearTimeout(timer);
          proc.kill('SIGKILL');
          reject(new Error('Session startup aborted'));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.onExit((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

    if (exit.error) throw exit.error;
    if (overLimit) {
      const notice = `[session-startup] output exceeded ${maxBytes} bytes; process killed`;
      return {
        stdout,
        stderr: stderr ? `${stderr}\n${notice}` : notice,
        exitCode: exit.code ?? 1,
      };
    }
    return { stdout, stderr, exitCode: exit.code };
  } finally {
    if (onAbort && opts.signal) {
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

async function persistStatusFile(
  io: SessionWorktreeIo,
  status: SessionStartupStatus,
): Promise<void> {
  try {
    await io.exec('mkdir -p .agent-hub-runtime', { timeoutMs: 30_000 });
    await io.writeFile(SESSION_STARTUP_STATUS_REL, `${JSON.stringify(status, null, 2)}\n`);
  } catch (err) {
    console.warn(
      `[session-startup] failed to write ${SESSION_STARTUP_STATUS_REL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function formatSessionStartupPromptSection(
  status: SessionStartupStatus | null,
  opts: { commandsConfigured?: boolean } = {},
): string {
  if (status?.status === 'skipped') return '';
  if (!status) {
    if (!opts.commandsConfigured) return '';
    return `\n\n## Session Startup Setup
Status: **pending** (startup hooks have not reported yet)
Status file: \`.agent-hub-runtime/session-startup.json\` (guest: \`${SESSION_STARTUP_STATUS_GUEST_ABS}\`)

Do **not** assume project deps (venv, node_modules, etc.) are ready yet. Poll the status file or wait before running tests that need them.`;
  }
  const lines = status.commands
    .map((c) => {
      const code = c.exitCode != null ? ` exit=${c.exitCode}` : '';
      const detail = c.detail ? ` — ${c.detail.split('\n')[0]!.slice(0, 120)}` : '';
      return `- \`${c.cmd}\`: ${c.status}${code}${detail}`;
    })
    .join('\n');
  const guidance =
    status.status === 'pending' || status.status === 'running'
      ? 'Do **not** assume project deps (venv, node_modules, etc.) are ready yet. Poll the status file or wait before running tests that need them.'
      : status.status === 'failed'
        ? 'Setup **failed**. Read the status file for detail, fix or re-run the failed command, then continue.'
        : 'Setup **completed**. Project startup commands finished successfully for this boot.';
  return `\n\n## Session Startup Setup
Status: **${status.status}** (boot \`${status.bootId.slice(0, 8)}\`)
Status file: \`${status.statusPath}\`

${lines}

${guidance}`;
}

export interface RunSessionStartupHooksArgs {
  sessionId: string;
  env: SessionEnv;
  commands: string[];
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (update: {
    runStatus: SessionStartupRunStatus;
    stepStatus: 'started' | 'completed' | 'failed';
    startedAt: number;
    finishedAt?: number;
    detail?: string;
  }) => void;
}

/**
 * Run project startup commands sequentially inside the session env.
 * Updates the in-memory registry + status file. Honors `signal` abort.
 */
export async function runSessionStartupHooks(
  args: RunSessionStartupHooksArgs,
): Promise<SessionStartupStatus> {
  const now = args.now ?? Date.now;
  const bootId = randomUUID();
  const startedAt = now();
  const statusPath = statusPathForEnv(args.env);

  if (args.commands.length === 0) {
    const skipped: SessionStartupStatus = {
      status: 'skipped',
      startedAt,
      finishedAt: startedAt,
      commands: [],
      bootId,
      statusPath,
    };
    statusBySession.set(args.sessionId, skipped);
    return skipped;
  }

  const status: SessionStartupStatus = {
    status: 'pending',
    startedAt,
    finishedAt: null,
    commands: args.commands.map((cmd) => ({
      cmd,
      status: 'pending',
      exitCode: null,
      detail: null,
    })),
    bootId,
    statusPath,
  };
  statusBySession.set(args.sessionId, status);
  await persistStatusFile(args.env.worktreeIo, status);
  args.onProgress?.({
    runStatus: 'pending',
    stepStatus: 'started',
    startedAt,
  });

  if (args.signal?.aborted) {
    status.status = 'failed';
    status.finishedAt = now();
    for (const c of status.commands) {
      if (c.status === 'pending') c.status = 'skipped';
    }
    statusBySession.set(args.sessionId, status);
    await persistStatusFile(args.env.worktreeIo, status);
    const detail = formatSessionStartupProgressDetail(status);
    console.warn(
      `[session-startup] session=${args.sessionId} aborted before commands ran` +
        (detail ? `\n${detail}` : ''),
    );
    args.onProgress?.({
      runStatus: 'failed',
      stepStatus: 'failed',
      startedAt,
      finishedAt: status.finishedAt,
      ...(detail ? { detail } : {}),
    });
    return status;
  }

  status.status = 'running';
  statusBySession.set(args.sessionId, status);
  await persistStatusFile(args.env.worktreeIo, status);

  for (let i = 0; i < status.commands.length; i++) {
    if (args.signal?.aborted) {
      for (let j = i; j < status.commands.length; j++) {
        status.commands[j]!.status = 'skipped';
      }
      status.status = 'failed';
      status.finishedAt = now();
      break;
    }

    const entry = status.commands[i]!;
    entry.status = 'running';
    statusBySession.set(args.sessionId, { ...status, commands: [...status.commands] });
    await persistStatusFile(args.env.worktreeIo, status);
    console.log(`[session-startup] session=${args.sessionId} running: ${entry.cmd}`);

    try {
      const result = await runStartupCommandInSessionWorkspace(args.env, entry.cmd, {
        timeoutMs: SESSION_STARTUP_COMMAND_TIMEOUT_MS,
        signal: args.signal,
      });
      if (args.signal?.aborted) {
        entry.status = 'skipped';
        for (let j = i + 1; j < status.commands.length; j++) {
          status.commands[j]!.status = 'skipped';
        }
        status.status = 'failed';
        status.finishedAt = now();
        break;
      }
      entry.exitCode = result.exitCode;
      if (result.exitCode === 0) {
        entry.status = 'ok';
        entry.detail = null;
        console.log(`[session-startup] session=${args.sessionId} ok: ${entry.cmd}`);
      } else {
        entry.status = 'failed';
        entry.detail = truncateDetail(result.stdout, result.stderr) ?? `exit ${result.exitCode}`;
        for (let j = i + 1; j < status.commands.length; j++) {
          status.commands[j]!.status = 'skipped';
        }
        status.status = 'failed';
        status.finishedAt = now();
        console.warn(
          `[session-startup] session=${args.sessionId} failed: ${entry.cmd} (exit ${result.exitCode})\n${entry.detail}`,
        );
        break;
      }
    } catch (err) {
      entry.status = 'failed';
      entry.exitCode = null;
      entry.detail = err instanceof Error ? err.message : String(err);
      for (let j = i + 1; j < status.commands.length; j++) {
        status.commands[j]!.status = 'skipped';
      }
      status.status = 'failed';
      status.finishedAt = now();
      console.warn(
        `[session-startup] session=${args.sessionId} failed: ${entry.cmd}\n${entry.detail}`,
      );
      break;
    }
  }

  if (status.status === 'running') {
    status.status = 'ready';
    status.finishedAt = now();
  }

  statusBySession.set(args.sessionId, status);
  await persistStatusFile(args.env.worktreeIo, status);
  const progressDetail =
    status.status === 'failed' ? formatSessionStartupProgressDetail(status) : undefined;
  if (status.status === 'ready') {
    console.log(
      `[session-startup] session=${args.sessionId} ready (${status.commands.length} command(s))`,
    );
  } else if (status.status === 'failed' && progressDetail) {
    // Already logged the failing command above; keep a one-line summary.
    console.warn(`[session-startup] session=${args.sessionId} setup failed`);
  }
  args.onProgress?.({
    runStatus: status.status,
    stepStatus: status.status === 'ready' ? 'completed' : 'failed',
    startedAt,
    finishedAt: status.finishedAt ?? now(),
    ...(progressDetail ? { detail: progressDetail } : {}),
  });
  return status;
}

/**
 * Fire-and-forget wrapper used by SessionEnvManager — never throws to the
 * ensure() caller. Returns the promise so dispose can await/abort.
 */
export function startSessionStartupHooks(
  args: RunSessionStartupHooksArgs,
): Promise<SessionStartupStatus> {
  return runSessionStartupHooks(args).catch((err) => {
    const failed: SessionStartupStatus = {
      status: 'failed',
      startedAt: args.now?.() ?? Date.now(),
      finishedAt: args.now?.() ?? Date.now(),
      commands: args.commands.map((cmd) => ({
        cmd,
        status: 'failed' as const,
        exitCode: null,
        detail: err instanceof Error ? err.message : String(err),
      })),
      bootId: randomUUID(),
      statusPath: statusPathForEnv(args.env),
    };
    statusBySession.set(args.sessionId, failed);
    const detail = formatSessionStartupProgressDetail(failed);
    console.warn(
      `[session-startup] session=${args.sessionId} failed: ${
        err instanceof Error ? err.message : String(err)
      }` + (detail ? `\n${detail}` : ''),
    );
    args.onProgress?.({
      runStatus: 'failed',
      stepStatus: 'failed',
      startedAt: failed.startedAt,
      finishedAt: failed.finishedAt ?? undefined,
      ...(detail ? { detail } : {}),
    });
    return failed;
  });
}
