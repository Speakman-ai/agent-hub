/**
 * How the Hub reaches ports inside a session container.
 *
 * Two routings exist, and the choice is forced by the platform rather than
 * by preference:
 *
 * - **`container-ip`** — the Hub connects straight to the container's address
 *   on the docker bridge. Nothing is published to the host, so there is no
 *   shared port pool to exhaust, no cross-session collision, and no need to
 *   know a port before the container starts. A service that comes up ten
 *   minutes into a session is reachable the moment it binds. This is the
 *   routing that makes a session behave like its own machine.
 *
 * - **`published-ports`** — the container maps `hostPort → internalPort` at
 *   `docker run` time and the Hub dials loopback. Every port must be declared
 *   up front, and they all draw from one host-wide pool.
 *
 * Container IPs are only routable from the host on Linux, where the bridge
 * lives in the host's own network namespace. On macOS and Windows, Docker
 * runs inside a VM and its bridge addresses are unreachable from a Hub
 * process on the host — publishing is the only option there.
 *
 * Getting this wrong is silent and slow to diagnose: the preview proxy would
 * hang trying to open a connection to an address that cannot answer, which
 * looks exactly like a dev server that never finished booting.
 */

export type SessionEnvPortRouting = 'container-ip' | 'published-ports';

/** Operator override; useful for a Hub in a container on a shared network. */
const ROUTING_ENV = 'AGENT_HUB_SESSION_ENV_PORT_ROUTING';

export interface ResolvePortRoutingOpts {
  env?: NodeJS.ProcessEnv;
  /** `process.platform`. Injected for tests. */
  platform?: NodeJS.Platform;
}

export function resolveSessionEnvPortRouting(
  opts: ResolvePortRoutingOpts = {},
): SessionEnvPortRouting {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  const override = env[ROUTING_ENV]?.trim();
  if (override === 'container-ip' || override === 'published-ports') return override;

  // Docker Desktop (darwin/win32) runs the daemon in a VM whose bridge is
  // not routable from the host. Anything else is assumed to be a Linux
  // daemon sharing the host's network namespace.
  return platform === 'linux' ? 'container-ip' : 'published-ports';
}

/**
 * Human-readable reason for the resolved routing, for the boot log. Operators
 * who expected container-IP routing and silently got publishing otherwise
 * have no way to tell why their port pool is still in play.
 */
export function describeSessionEnvPortRouting(opts: ResolvePortRoutingOpts = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const routing = resolveSessionEnvPortRouting(opts);
  const override = env[ROUTING_ENV]?.trim();
  if (override === 'container-ip' || override === 'published-ports') {
    return `${routing} (forced by ${ROUTING_ENV})`;
  }
  return routing === 'container-ip'
    ? 'container-ip (linux: docker bridge is reachable from the host)'
    : `published-ports (${platform}: docker runs in a VM, container IPs are not routable)`;
}
