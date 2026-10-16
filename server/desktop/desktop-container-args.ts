/**
 * Pure `docker` argv builders for the desktop container. The Hub-host docker
 * placement and the runner-fleet agent both start desktops through these, so
 * the two run the image with identical hardening.
 */
import { DESKTOP_CONTROL_PORT } from './desktop-control-client.js';

export const DEFAULT_DESKTOP_IMAGE = 'agent-hub/desktop:dev';
export const DEFAULT_DESKTOP_MEMORY = '4g';
export const DEFAULT_DESKTOP_CPUS = '2';
/** Label on every desktop container; the value is the computer id. */
export const DESKTOP_LABEL = 'agent-hub.desktop';
/** Mount point of the persistent home inside the image (uid 1000). */
export const DESKTOP_HOME_DIR = '/home/desktop';

export interface DesktopContainerLimits {
  image: string;
  memory: string;
  cpus: string;
}

export function resolveDesktopContainerLimits(
  env: NodeJS.ProcessEnv = process.env,
): DesktopContainerLimits {
  return {
    image: env.AGENT_HUB_DESKTOP_IMAGE?.trim() || DEFAULT_DESKTOP_IMAGE,
    memory: env.AGENT_HUB_DESKTOP_MEMORY?.trim() || DEFAULT_DESKTOP_MEMORY,
    cpus: env.AGENT_HUB_DESKTOP_CPUS?.trim() || DEFAULT_DESKTOP_CPUS,
  };
}

export function desktopContainerName(computerId: string): string {
  return `agent-hub-desktop-${computerId}`;
}

export function desktopHomeVolumeName(computerId: string): string {
  return `agent-hub-desktop-home-${computerId}`;
}

/**
 * `docker run` for a desktop. The control token is passed by name only
 * (`-e DESKTOP_CONTROL_TOKEN`), so the caller must put its value in the child
 * process env; it never appears in argv or `ps`.
 */
export function buildDesktopRunArgv(opts: {
  name: string;
  computerId: string;
  volume: string;
  limits: DesktopContainerLimits;
  /** Host interface the control port binds to; omit for all interfaces. */
  publishHost?: string;
}): string[] {
  const publish = opts.publishHost
    ? `${opts.publishHost}::${DESKTOP_CONTROL_PORT}`
    : String(DESKTOP_CONTROL_PORT);
  return [
    'docker',
    'run',
    '-d',
    '--name',
    opts.name,
    '--label',
    `${DESKTOP_LABEL}=${opts.computerId}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '2048',
    '--memory',
    opts.limits.memory,
    '--memory-swap',
    opts.limits.memory,
    '--cpus',
    opts.limits.cpus,
    '-e',
    'DESKTOP_CONTROL_TOKEN',
    '-v',
    `${opts.volume}:${DESKTOP_HOME_DIR}`,
    '-p',
    publish,
    opts.limits.image,
  ];
}

/** Run `tar` from the desktop image against a home volume (snapshot/restore). */
export function buildDesktopHomeTarArgv(opts: {
  volume: string;
  image: string;
  mode: 'snapshot' | 'restore';
}): string[] {
  const tar =
    opts.mode === 'snapshot'
      ? ['-czf', '-', '-C', DESKTOP_HOME_DIR, '.']
      : ['-xzf', '-', '-C', DESKTOP_HOME_DIR];
  return [
    'docker',
    'run',
    '--rm',
    ...(opts.mode === 'restore' ? ['-i'] : []),
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'none',
    '-v',
    `${opts.volume}:${DESKTOP_HOME_DIR}`,
    '--entrypoint',
    'tar',
    opts.image,
    ...tar,
  ];
}
