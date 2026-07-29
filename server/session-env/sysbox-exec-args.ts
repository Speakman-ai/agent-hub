/**
 * sysbox-exec-args.ts — pure argv/name/mount/port-publish builders for the
 * SessionEnv sysbox adapter.
 *
 * Everything here is string/argv construction only; the runtime that spawns
 * `docker` lives in sysbox-session-env.ts (and injects fakes in tests). The
 * split mirrors finalize/runner-exec-args.ts, where keeping the builders pure
 * is what makes the container invocations unit-testable without a daemon.
 *
 * Security posture (epic decision `isolation`): the session container runs
 * under the `sysbox-runc` runtime — a real user-namespace boundary. The
 * builders here must NEVER emit `--privileged`, `--cgroupns=host`, or a host
 * docker-socket mount; the project's own `docker compose` services run on the
 * INNER dockerd that the container entrypoint starts.
 */

import { resolveHostMountPath } from '../finalize/runner-exec-args.js';
import { DEFAULT_UBUNTU_24_04_IMAGE } from '../finalize/runner-images.js';

/** The session worktree as seen from inside the container. */
export const SYSBOX_SESSION_WORKSPACE = '/workspace';

/** Label marking session-env containers/volumes for the boot reconcile sweep. */
export const SYSBOX_SESSION_LABEL_KEY = 'agent-hub.kind';
export const SYSBOX_SESSION_LABEL_VALUE = 'session-env';
export const SYSBOX_SESSION_LABEL = `${SYSBOX_SESSION_LABEL_KEY}=${SYSBOX_SESSION_LABEL_VALUE}`;
export const SYSBOX_SESSION_ID_LABEL_KEY = 'agent-hub.session-id';

/**
 * User the adapter execs as inside the container. The default session image
 * (the finalize runner image) provisions this non-root sudoer user.
 */
export const SYSBOX_EXEC_USER = 'runner';

/**
 * In-container command that boots the env: starts the inner dockerd and holds
 * the container open. The finalize runner entrypoint does exactly this (and
 * needs no `--privileged` under sysbox — sysbox virtualizes what DinD needs).
 */
export const SYSBOX_SESSION_ENTRYPOINT = ['/usr/local/bin/runner-entrypoint.sh', 'daemon'];

/**
 * Session container image. Defaults to the finalize runner image: it already
 * ships the toolchain a dev env needs (node, docker, compose, git), is pulled
 * on every Hub restart, and its entrypoint starts an inner dockerd. Override
 * with AGENT_HUB_SYSBOX_SESSION_IMAGE for a dedicated session image.
 */
export function resolveSysboxSessionImage(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENT_HUB_SYSBOX_SESSION_IMAGE?.trim() ||
    env.FINALIZE_RUNNER_IMAGE_UBUNTU_24_04?.trim() ||
    DEFAULT_UBUNTU_24_04_IMAGE
  );
}

/** Stable per-session container name (docker name charset, bounded length). */
export function sysboxSessionContainerName(sessionId: string): string {
  // The same value is also passed to `docker run --hostname`, whose Linux
  // hostname limit is 63 characters. Keep the full name inside that bound.
  const slug =
    sessionId
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 46) || 'unknown';
  return `agenthub-session-${slug}`.toLowerCase();
}

/**
 * Named volume backing the INNER dockerd's /var/lib/docker. Named (not
 * anonymous) so teardown can remove it explicitly — `docker rm -v` only
 * removes anonymous volumes, and the inner image cache is the disk-growth
 * vector (see docs/deployment/SYSBOX-HOST-SETUP.md, disk headroom).
 */
export function sysboxGraphVolumeName(containerName: string): string {
  return `${containerName}-graph`.slice(0, 120);
}

export interface SysboxPortPublish {
  internalPort: number;
  hostPort: number;
}

function pushEnvArgs(args: string[], env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
}

function sessionLabels(sessionId: string): string[] {
  return [
    '--label',
    SYSBOX_SESSION_LABEL,
    '--label',
    `${SYSBOX_SESSION_ID_LABEL_KEY}=${sessionId}`,
  ];
}

/**
 * Build argv for `docker volume create` of the inner-docker graph volume.
 * Created explicitly (rather than implicitly by `docker run -v name:path`)
 * because implicit named volumes carry no labels, and the reconcile sweep
 * finds leaked volumes by label.
 */
export function buildCreateSysboxGraphVolumeArgv(opts: {
  containerName: string;
  sessionId: string;
}): string[] {
  return [
    'docker',
    'volume',
    'create',
    ...sessionLabels(opts.sessionId),
    sysboxGraphVolumeName(opts.containerName),
  ];
}

export interface StartSysboxContainerOptions {
  sessionId: string;
  containerName: string;
  image: string;
  /** Worktree path as the Hub sees it (translated to a host path for `-v`). */
  worktreePath: string;
  /** Loopback-only port publishes, fixed at container start. */
  ports: SysboxPortPublish[];
  /** Extra container env (`-e`). The image env is the base; no host env leaks. */
  env?: Record<string, string>;
  /** In-container command holding the env open. Default {@link SYSBOX_SESSION_ENTRYPOINT}. */
  command?: string[];
}

/**
 * Build argv for `docker run -d --runtime=sysbox-runc ...`.
 *
 * Invariants (the tests pin these):
 *   - `--runtime=sysbox-runc`, never `--privileged` / `--cgroupns=host`
 *   - no host docker-socket mount — docker inside is the INNER dockerd
 *   - port publishes bind 127.0.0.1 only (epic decision `port-model`)
 */
export function buildStartSysboxContainerArgv(opts: StartSysboxContainerOptions): string[] {
  const hostMount = resolveHostMountPath(opts.worktreePath);
  const args = [
    'run',
    '-d',
    '--runtime=sysbox-runc',
    '--name',
    opts.containerName,
    '--hostname',
    opts.containerName,
    ...sessionLabels(opts.sessionId),
  ];

  args.push('-v', `${hostMount}:${SYSBOX_SESSION_WORKSPACE}:rw`);
  args.push('-v', `${sysboxGraphVolumeName(opts.containerName)}:/var/lib/docker`);

  for (const port of opts.ports) {
    args.push('-p', `127.0.0.1:${port.hostPort}:${port.internalPort}`);
  }

  args.push('-w', SYSBOX_SESSION_WORKSPACE);
  pushEnvArgs(args, opts.env);

  args.push(opts.image, ...(opts.command ?? SYSBOX_SESSION_ENTRYPOINT));
  return ['docker', ...args];
}

/** In-container pidfile for one spawned process (unique per spawn). */
export function sysboxSpawnPidFile(spawnSeq: number): string {
  return `/tmp/agenthub-proc-${spawnSeq}.pid`;
}

export interface ExecSysboxSpawnOptions {
  containerName: string;
  /** User shell command (run via `sh -c` inside the container). */
  command: string;
  /** Absolute in-container cwd (already resolved against {@link SYSBOX_SESSION_WORKSPACE}). */
  cwd: string;
  env?: Record<string, string>;
  pidFile: string;
}

/**
 * Build argv for a streamed `docker exec` running one session process.
 *
 * The wrapper script records its own pid then `exec`s into the user command
 * (same pid), so {@link buildSysboxKillArgv} can signal it later. The user
 * command travels as a positional parameter — never interpolated into the
 * script — so no shell-quoting of user input happens anywhere.
 */
export function buildExecSysboxSpawnArgv(opts: ExecSysboxSpawnOptions): string[] {
  const args = ['exec', '-i', '-u', SYSBOX_EXEC_USER, '-w', opts.cwd];
  pushEnvArgs(args, opts.env);
  args.push(
    opts.containerName,
    'sh',
    '-c',
    'echo "$$" >"$1"; exec sh -c "$2"',
    'sh',
    opts.pidFile,
    opts.command,
  );
  return ['docker', ...args];
}

/**
 * Build argv for signalling a spawned process via its pidfile. Tries the
 * process group first, falls back to the pid (same policy as the host
 * adapter); a missing pidfile / dead pid is a silent no-op. `docker rm -f`
 * at dispose is the backstop that kills the whole namespace regardless.
 */
export function buildSysboxKillArgv(opts: {
  containerName: string;
  pidFile: string;
  signal: NodeJS.Signals;
}): string[] {
  const script =
    'p=$(cat "$1" 2>/dev/null) || exit 0; ' +
    'kill -s "$2" -- "-$p" 2>/dev/null || kill -s "$2" "$p" 2>/dev/null || true';
  return [
    'docker',
    'exec',
    opts.containerName,
    'sh',
    '-c',
    script,
    'sh',
    opts.pidFile,
    opts.signal.replace(/^SIG/, ''),
  ];
}

export interface ExecSysboxPtyOptions {
  containerName: string;
  /** Program to run. Defaults to bash (present in the default session image). */
  command?: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}

/**
 * Build `docker` args for an interactive PTY exec. The host node-pty spawns
 * `docker` with these args; `docker exec -it` propagates the client TTY size
 * (and SIGWINCH resizes) to the in-container process.
 */
export function buildExecSysboxPtyArgs(opts: ExecSysboxPtyOptions): string[] {
  const args = ['exec', '-it', '-u', SYSBOX_EXEC_USER, '-w', opts.cwd];
  pushEnvArgs(args, opts.env);
  args.push(opts.containerName, opts.command ?? '/bin/bash', ...(opts.args ?? []));
  return args;
}

/** Build argv for `docker rm -f -v <name>` (kills every in-container process). */
export function buildStopSysboxContainerArgv(containerName: string): string[] {
  return ['docker', 'rm', '-f', '-v', containerName];
}

/**
 * Build argv to remove the named graph volume. Must run AFTER container
 * removal — a volume in use by a container cannot be removed.
 */
export function buildRemoveSysboxGraphVolumeArgv(containerName: string): string[] {
  return ['docker', 'volume', 'rm', '-f', sysboxGraphVolumeName(containerName)];
}

// ── Reconcile sweep (leaked container/volume GC) ───────────────────

/** List ALL session-env containers (running or exited), ids only. */
export function buildListSysboxSessionContainersArgv(): string[] {
  return ['docker', 'ps', '-aq', '--filter', `label=${SYSBOX_SESSION_LABEL}`];
}

/** List session-env graph volumes by label, names only. */
export function buildListSysboxSessionVolumesArgv(): string[] {
  return ['docker', 'volume', 'ls', '-q', '--filter', `label=${SYSBOX_SESSION_LABEL}`];
}
