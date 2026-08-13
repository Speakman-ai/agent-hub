/**
 * sysbox-exec-args.ts — pure argv/name/mount/port-publish builders for the
 * SessionEnv sysbox adapter.
 *
 * Everything here is string/argv construction only; the runtime that spawns
 * `docker` lives in sysbox-session-env.ts (and injects fakes in tests). The
 * split mirrors finalize/runner-exec-args.ts, where keeping the builders pure
 * is what makes the container invocations unit-testable without a daemon.
 *
 * Isolation runtimes
 * ──────────────────
 * The builders emit one of two container shapes, selected per env:
 *
 *   - `sysbox-runc` — `--runtime=sysbox-runc`, a real user-namespace
 *     boundary. Strictly better, but it needs sysbox installed on the host.
 *   - `privileged` — `--privileged --cgroupns=host`, the same shape Finalize
 *     CI already runs on these machines. A weaker boundary, but it works
 *     anywhere Docker does.
 *
 * Requiring sysbox meant that on any host without it, sessions silently ran
 * with *no* isolation at all — every session's processes, ports, and services
 * sharing the Hub host. A privileged container is a weaker boundary than
 * sysbox and a far stronger one than that, so it is the fallback rather than
 * "give up and use the host."
 *
 * In BOTH modes there is no host docker-socket mount: the project's own
 * `docker compose` services run on the INNER dockerd the entrypoint starts.
 * That invariant is not negotiable in either shape.
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

/**
 * Numeric owner of the bind-mounted worktree, as the Hub sees it. The
 * container entrypoint aligns its `runner` account with these ids; without
 * that the mount is read-only to the session and git rejects the checkout as
 * "dubious ownership". See `align_runner_identity` in the runner entrypoint.
 */
export const WORKSPACE_UID_ENV = 'AGENT_HUB_WORKSPACE_UID';
export const WORKSPACE_GID_ENV = 'AGENT_HUB_WORKSPACE_GID';

export interface WorkspaceOwner {
  uid: number;
  gid: number;
}

/** Container env carrying {@link WorkspaceOwner}; empty when unknown. */
export function workspaceOwnerEnv(owner: WorkspaceOwner | null): Record<string, string> {
  if (!owner) return {};
  return {
    [WORKSPACE_UID_ENV]: String(owner.uid),
    [WORKSPACE_GID_ENV]: String(owner.gid),
  };
}

/** Container isolation runtime. See the module header. */
export type ContainerIsolation = 'sysbox-runc' | 'privileged';

/** `docker run` flags that select the isolation runtime. */
export function isolationRunArgs(isolation: ContainerIsolation): string[] {
  switch (isolation) {
    case 'sysbox-runc':
      return ['--runtime=sysbox-runc'];
    case 'privileged':
      // `--cgroupns=host` matches the Finalize runner: the inner dockerd
      // needs its own cgroup view to start reliably.
      return ['--privileged', '--cgroupns=host'];
    default: {
      const exhaustive: never = isolation;
      throw new Error(`Unhandled container isolation: ${String(exhaustive)}`);
    }
  }
}

function pushEnvArgs(args: string[], env: Record<string, string | undefined> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    // An undefined value means "unset" — the container env is the image env
    // (no host env leaks in), so simply omitting the `-e` is the unset.
    if (value === undefined) continue;
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
  /**
   * Loopback-only port publishes, fixed at container start. Empty under
   * container-IP routing, where the Hub dials the container directly and
   * nothing needs publishing.
   */
  ports: SysboxPortPublish[];
  /** Isolation runtime. Default `sysbox-runc` (back-compat). */
  isolation?: ContainerIsolation;
  /** Extra container env (`-e`). The image env is the base; no host env leaks. */
  env?: Record<string, string>;
  /** In-container command holding the env open. Default {@link SYSBOX_SESSION_ENTRYPOINT}. */
  command?: string[];
}

/**
 * Build argv for `docker run -d ...` starting a session container.
 *
 * Invariants (the tests pin these):
 *   - exactly one isolation runtime, per {@link isolationRunArgs}
 *   - no host docker-socket mount in either mode — docker inside the
 *     container is the INNER dockerd
 *   - any port publishes bind 127.0.0.1 only, never `0.0.0.0`
 */
export function buildStartSysboxContainerArgv(opts: StartSysboxContainerOptions): string[] {
  const hostMount = resolveHostMountPath(opts.worktreePath);
  const args = [
    'run',
    '-d',
    ...isolationRunArgs(opts.isolation ?? 'sysbox-runc'),
    '--name',
    opts.containerName,
    '--hostname',
    opts.containerName,
    ...sessionLabels(opts.sessionId),
  ];

  // Boot as root so the entrypoint can align `runner` with the worktree owner:
  // usermod refuses a uid change while any process runs as that user, and the
  // image's own USER would make the entrypoint exactly such a process. Nothing
  // interactive lands here — every exec below pins `-u runner`, which resolves
  // to the aligned ids.
  args.push('--user', 'root');

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

/**
 * Build argv reading the container's own IP address.
 *
 * Under container-IP routing this is the Hub's upstream host: no port is
 * published, so the only route in is the container's address on the docker
 * bridge. Emitting one address per attached network (space-separated) lets
 * the caller take the first non-empty one without assuming a network name.
 */
export function buildInspectContainerIpArgv(containerName: string): string[] {
  return [
    'docker',
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    containerName,
  ];
}

/** First non-empty address from {@link buildInspectContainerIpArgv} output. */
export function parseContainerIp(stdout: string): string | null {
  for (const token of stdout.trim().split(/\s+/)) {
    if (token) return token;
  }
  return null;
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
  /** `undefined` values mean "unset" and are omitted from the exec argv. */
  env?: Record<string, string | undefined>;
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
