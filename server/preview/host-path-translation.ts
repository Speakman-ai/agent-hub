/**
 * Container -> host path translation for docker-compose previews.
 *
 * Why this exists:
 *
 *   The Agent Hub server runs in a container with `/var/run/docker.sock`
 *   bind-mounted in. That makes the container a docker **client** while
 *   the **daemon** still runs on the EC2 host. When we shell out to
 *   `docker compose`, the CLI (running in our container) resolves any
 *   relative bind-mount sources in the compose YAML against its own
 *   working directory and ships absolute paths to the daemon. The daemon
 *   then opens those absolute paths on the **host** filesystem — where
 *   our container-local paths like `/home/node/projects/<id>` either
 *   don't exist or point at unrelated content. The result: services that
 *   bind-mount source (e.g. a frontend running `npm ci` against
 *   `./frontend:/app`) see an empty directory and fail in a loop.
 *
 *   Confirmed against compose-go (`paths/resolve.go::ResolveRelativePaths`
 *   uses `project.WorkingDir` as the base for `filepath.Join` over volume
 *   sources) and the docker CLI reference. The supported way to override
 *   that working-dir base is `--project-directory <hostPath>` on the
 *   `docker compose` invocation. compose-go then ships the host-rooted
 *   absolute path to the daemon, which can resolve it correctly.
 *
 * Contract:
 *
 *   - `AGENT_HUB_HOST_PROJECTS_DIR` (env): set by the deployment scripts
 *     to the host filesystem path that backs the bind-mount of the
 *     container's projects directory. On EC2 this is `<DATA_ROOT>/projects`
 *     where `DATA_ROOT` is the data root that terraform configures.
 *     When unset, translation is a no-op so dev / Electron / non-container
 *     installs are unaffected.
 *
 *   - `AGENT_HUB_CONTAINER_PROJECTS_DIR` (env, optional): the container-side
 *     mountpoint. Defaults to `/home/node/projects` which matches the
 *     terraform-rendered docker run.
 *
 *   - {@link translateContainerPathToHost} rewrites a container path that
 *     starts with the container projects root so the equivalent host path
 *     is returned. Paths outside the bind-mounted root (most notably
 *     worktrees under `~/.agent-hub/workspaces/`, which are NOT
 *     bind-mounted) come back as `null` with a warning surfaced via the
 *     `onWarn` callback — the caller decides whether to continue with no
 *     `--project-directory` flag or to surface a hard error.
 *
 * Worktree caveat:
 *
 *   This translation only helps when the compose preview launches against
 *   `project.cwd` (the bind-mounted projects dir). When it launches from
 *   a worktree, the worktree itself isn't bind-mounted to the host, so
 *   there's no host path that contains the source files at all. That's a
 *   separate, larger design problem — tracked under follow-up card.
 */

const DEFAULT_CONTAINER_PROJECTS_DIR = '/home/node/projects';

export interface HostPathTranslation {
  /** Container path that was passed in (unchanged). */
  readonly containerPath: string;
  /**
   * Host-side path docker daemon can resolve. `null` when translation
   * isn't possible (env unset, or `containerPath` outside the bind-mounted
   * root).
   */
  readonly hostPath: string | null;
  /**
   * Human-readable reason translation was skipped. Always set when
   * `hostPath` is `null`, so callers can log it consistently.
   */
  readonly skippedReason?: string;
}

export interface TranslateContainerPathOptions {
  /**
   * Override for the `AGENT_HUB_HOST_PROJECTS_DIR` env var. Tests inject
   * this so the helper can be exercised without mutating process env.
   */
  readonly hostProjectsDir?: string | null;
  /**
   * Override for the `AGENT_HUB_CONTAINER_PROJECTS_DIR` env var. Defaults
   * to {@link DEFAULT_CONTAINER_PROJECTS_DIR} when neither this nor the
   * env var is set.
   */
  readonly containerProjectsDir?: string | null;
}

function trimTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.replace(/\/+$/, '');
  return p;
}

/**
 * Translate a container-visible path to the equivalent host path the
 * docker daemon would see. Returns `{ hostPath: null, skippedReason }`
 * when translation isn't possible — never throws.
 */
export function translateContainerPathToHost(
  containerPath: string,
  options: TranslateContainerPathOptions = {},
): HostPathTranslation {
  const trimmedInput = (containerPath ?? '').trim();
  if (!trimmedInput) {
    return {
      containerPath,
      hostPath: null,
      skippedReason: 'empty container path',
    };
  }

  const hostProjectsDirRaw =
    options.hostProjectsDir !== undefined
      ? options.hostProjectsDir
      : (process.env.AGENT_HUB_HOST_PROJECTS_DIR ?? null);
  if (!hostProjectsDirRaw || !hostProjectsDirRaw.trim()) {
    return {
      containerPath,
      hostPath: null,
      skippedReason: 'AGENT_HUB_HOST_PROJECTS_DIR is unset',
    };
  }

  const containerProjectsDirRaw =
    options.containerProjectsDir !== undefined
      ? options.containerProjectsDir
      : (process.env.AGENT_HUB_CONTAINER_PROJECTS_DIR ?? DEFAULT_CONTAINER_PROJECTS_DIR);
  const containerRoot = trimTrailingSlash((containerProjectsDirRaw ?? '').trim());
  const hostRoot = trimTrailingSlash(hostProjectsDirRaw.trim());
  if (!containerRoot) {
    return {
      containerPath,
      hostPath: null,
      skippedReason: 'container projects dir resolves to empty string',
    };
  }

  const normalisedInput = trimTrailingSlash(trimmedInput);
  if (normalisedInput === containerRoot) {
    return { containerPath, hostPath: hostRoot };
  }
  const containerRootWithSlash = `${containerRoot}/`;
  if (!normalisedInput.startsWith(containerRootWithSlash)) {
    return {
      containerPath,
      hostPath: null,
      skippedReason: `path is outside the bind-mounted projects root (expected prefix ${containerRoot})`,
    };
  }
  const suffix = normalisedInput.slice(containerRoot.length);
  return { containerPath, hostPath: `${hostRoot}${suffix}` };
}
