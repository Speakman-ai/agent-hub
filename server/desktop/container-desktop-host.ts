/**
 * Where container desktops physically run. The lifecycle (leases, idle stop,
 * capacity) lives in container-desktop-runtime.ts and is the same for both
 * placements; a host only starts, inspects and stops containers and owns the
 * persistent home.
 *
 *   - hub-docker: `docker run` on the Hub host, home on a named volume.
 *   - runner-fleet: a `desktop` job on the runner queue (fleet-desktop-host.ts);
 *     the home is snapshotted to the desktop home store between runs.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { DesktopComputerKey, DesktopDisplayEndpoint } from './desktop-runtime.js';
import type { DesktopContainerPlacement } from './desktop-runtime-selection.js';
import { DESKTOP_CONTROL_PORT } from './desktop-control-client.js';
import {
  buildDesktopRunArgv,
  desktopContainerName,
  desktopHomeVolumeName,
  resolveDesktopContainerLimits,
  type DesktopContainerLimits,
} from './desktop-container-args.js';
import { parseDockerPortOutput } from '../finalize/runner-environment.js';
import { isNoSuchContainerError } from '../finalize/runner-agent-environment.js';

export type DesktopHostState =
  | 'pending' // queued, no runner yet (fleet only)
  | 'starting'
  | 'running'
  | 'stopped'
  | 'lost'; // died or vanished without being stopped

export interface DesktopHostStatus {
  state: DesktopHostState;
  endpoint: DesktopDisplayEndpoint | null;
  detail: string | null;
}

export interface DesktopHostStartRequest {
  computerId: string;
  key: DesktopComputerKey;
  controlToken: string;
  /** The record's home ref, when it was written by this placement. */
  homeRef: string | null;
  /** From `allocateRef`, already recorded as the computer's runner ref. */
  runnerRef: string;
}

export interface DesktopHostStartResult {
  /** Home ref to persist on the record (hub-docker: the volume name). */
  homeRef: string | null;
}

export interface DesktopContainerHost {
  readonly placement: DesktopContainerPlacement;
  /**
   * The runner ref for the next start. The runtime records it durably before
   * calling `start`, which must create the container (or queue job) under
   * exactly this ref: ownership is always written ahead of the resource, so
   * a failed create or a Hub crash at any point leaves a record pointing at
   * whatever may exist. A ref with nothing behind it reads as `lost`.
   */
  allocateRef(computerId: string): string;
  start(req: DesktopHostStartRequest): Promise<DesktopHostStartResult>;
  status(runnerRef: string): Promise<DesktopHostStatus>;
  /**
   * Ask the container to stop, keeping the home. Idempotent. `confirmed` is
   * true only once the container is known to be gone; until then the caller
   * keeps the ref (and its capacity slot) and asks again later.
   */
  stop(runnerRef: string, computerId: string): Promise<{ confirmed: boolean }>;
  /** Remove the persistent home. The container must already be stopped. */
  deleteHome(computerId: string): Promise<void>;
}

export interface DockerCli {
  /** Run docker with argv (no `docker` prefix). Rejects on non-zero exit. */
  run(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string }>;
}

const execFileAsync = promisify(execFile);

export function realDockerCli(): DockerCli {
  return {
    async run(args, env) {
      const { stdout } = await execFileAsync('docker', args, {
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: String(stdout) };
    },
  };
}

function isNoSuchVolumeError(err: unknown): boolean {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
  return /no such volume/i.test(stderr);
}

export interface HubDockerDesktopHostDeps {
  docker?: DockerCli;
  env?: NodeJS.ProcessEnv;
  limits?: DesktopContainerLimits;
}

export function createHubDockerDesktopHost(
  deps: HubDockerDesktopHostDeps = {},
): DesktopContainerHost {
  const docker = deps.docker ?? realDockerCli();
  const env = deps.env ?? process.env;
  const limits = deps.limits ?? resolveDesktopContainerLimits(env);
  // Same reachability rule as Hub-local PR environments: loopback unless the
  // Hub reaches sibling containers through a docker-host gateway.
  const gatewayHost = env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim() || '127.0.0.1';
  const publishHost =
    env.FINALIZE_ENV_PUBLISH_HOST?.trim() ||
    (env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim() ? undefined : '127.0.0.1');

  async function removeContainer(name: string): Promise<void> {
    try {
      await docker.run(['rm', '-f', name]);
    } catch (err) {
      if (!isNoSuchContainerError(err)) throw err;
    }
  }

  return {
    placement: 'hub-docker',
    allocateRef: desktopContainerName,
    async start(req) {
      const name = req.runnerRef;
      const volume = desktopHomeVolumeName(req.computerId);
      // Idempotent: an existing volume (the persistent home) is reused.
      await docker.run(['volume', 'create', volume]);
      // A leftover container from a crash would hold the name.
      await removeContainer(name);
      const argv = buildDesktopRunArgv({
        name,
        computerId: req.computerId,
        volume,
        limits,
        publishHost,
      });
      // A failure here may still have created the container; the runtime
      // recorded `name` beforehand and removes it through `stop`.
      await docker.run(argv.slice(1), { DESKTOP_CONTROL_TOKEN: req.controlToken });
      return { homeRef: volume };
    },
    async status(runnerRef) {
      let running: boolean;
      try {
        const { stdout } = await docker.run(['inspect', '-f', '{{.State.Running}}', runnerRef]);
        running = stdout.trim() === 'true';
      } catch (err) {
        if (isNoSuchContainerError(err)) {
          return { state: 'lost', endpoint: null, detail: 'the desktop container is gone' };
        }
        throw err;
      }
      if (!running) {
        return { state: 'lost', endpoint: null, detail: 'the desktop container stopped' };
      }
      const { stdout } = await docker.run(['port', runnerRef, String(DESKTOP_CONTROL_PORT)]);
      const port = parseDockerPortOutput(stdout);
      if (!port) return { state: 'starting', endpoint: null, detail: null };
      return { state: 'running', endpoint: { host: gatewayHost, port }, detail: null };
    },
    async stop(runnerRef) {
      // The home is a named volume, so removing the container keeps it. `rm -f`
      // returning (or "no such container") is the confirmation.
      await removeContainer(runnerRef);
      return { confirmed: true };
    },
    async deleteHome(computerId) {
      await removeContainer(desktopContainerName(computerId));
      try {
        await docker.run(['volume', 'rm', '-f', desktopHomeVolumeName(computerId)]);
      } catch (err) {
        if (!isNoSuchVolumeError(err)) throw err;
      }
    },
  };
}
