/**
 * Docker availability gate for the Hub's background reapers.
 *
 * The Hub schedules two docker-dependent background jobs: the finalize DinD
 * runner reaper (`finalize-reaper`, every 60 s) and the compose-mode preview
 * reaper. Both shell out to the host `docker` CLI. When the Hub process has no
 * reachable docker daemon, every tick throws
 *   `dial unix /var/run/docker.sock: connect: no such file or directory`
 * and floods the logs once a minute, forever, with nothing actionable.
 *
 * The canonical case is a **preview of agent-hub itself**: `compose.preview.yml`
 * boots the full Hub image as a session preview, and a preview (correctly) does
 * NOT get the host docker socket bind-mounted. The nested Hub then has no docker
 * and must not run docker-dependent reapers. The same is true for any docker-less
 * deployment.
 *
 * This module decides whether those reapers should run:
 *   1. Explicit override `AGENT_HUB_DISABLE_DOCKER_FEATURES` always wins
 *      (truthy => disabled, falsy => forced-enabled, ignoring the probe).
 *   2. Otherwise probe the resolved docker socket path: if it exists and is a
 *      unix socket, features are enabled; if it's missing, they're disabled.
 *
 * NOTE: the process-based legacy preview reaper does NOT depend on docker and is
 * intentionally left running regardless of this gate.
 */

import { statSync } from 'node:fs';

/** Docker's compiled-in default unix socket path. */
export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/** Env var operators can set to force the docker reapers on/off explicitly. */
export const DISABLE_DOCKER_FEATURES_ENV = 'AGENT_HUB_DISABLE_DOCKER_FEATURES';

export interface DockerAvailabilityDeps {
  /** Defaults to `process.env`. Injected for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Returns true when `path` exists and is a unix socket. Defaults to a
   * `statSync(...).isSocket()` probe. Injected for tests so we never touch the
   * real filesystem (and never spawn the docker CLI).
   */
  socketExists?: (path: string) => boolean;
}

export interface DockerAvailability {
  enabled: boolean;
  /** Human-readable explanation, suitable for a single startup log line. */
  reason: string;
}

function meansTrue(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function meansFalse(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

function defaultSocketExists(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * Resolve the docker unix socket path the CLI would connect to, honoring
 * `DOCKER_HOST` (`unix://` form) and `FINALIZE_DOCKER_SOCKET`, falling back to
 * the compiled-in default. Returns `null` when `DOCKER_HOST` points at a
 * non-unix transport (e.g. `tcp://`), which we cannot probe via the filesystem.
 */
export function resolveDockerSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dockerHost = env.DOCKER_HOST?.trim();
  if (dockerHost) {
    if (dockerHost.startsWith('unix://')) {
      return dockerHost.slice('unix://'.length) || DEFAULT_DOCKER_SOCKET;
    }
    // tcp:// / npipe:// / ssh:// — not a local unix socket we can stat.
    return null;
  }
  const finalizeSock = env.FINALIZE_DOCKER_SOCKET?.trim();
  if (finalizeSock) return finalizeSock;
  return DEFAULT_DOCKER_SOCKET;
}

/**
 * Decide whether the Hub's docker-dependent reapers should run.
 *
 * - Explicit `AGENT_HUB_DISABLE_DOCKER_FEATURES` wins over the probe.
 * - A non-unix `DOCKER_HOST` (tcp/ssh) can't be filesystem-probed, so we
 *   assume the daemon is reachable and leave the reapers enabled.
 * - Otherwise the reapers are enabled iff the resolved socket exists.
 */
export function resolveDockerAvailability(deps: DockerAvailabilityDeps = {}): DockerAvailability {
  const env = deps.env ?? process.env;
  const socketExists = deps.socketExists ?? defaultSocketExists;

  const override = env[DISABLE_DOCKER_FEATURES_ENV];
  if (meansTrue(override)) {
    return { enabled: false, reason: `disabled via ${DISABLE_DOCKER_FEATURES_ENV}` };
  }
  if (meansFalse(override)) {
    return { enabled: true, reason: `forced on via ${DISABLE_DOCKER_FEATURES_ENV}` };
  }

  const socketPath = resolveDockerSocketPath(env);
  if (socketPath === null) {
    return { enabled: true, reason: 'non-unix DOCKER_HOST — assuming docker is reachable' };
  }
  if (socketExists(socketPath)) {
    return { enabled: true, reason: `docker socket present at ${socketPath}` };
  }
  return {
    enabled: false,
    reason:
      `docker socket ${socketPath} not found — finalize + compose-preview reapers disabled ` +
      `(set ${DISABLE_DOCKER_FEATURES_ENV}=0 to force on)`,
  };
}
