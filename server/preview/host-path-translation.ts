/**
 * Container -> host path translation for sibling docker spawns.
 *
 * Why this exists:
 *
 *   The Agent Hub server runs in a container with `/var/run/docker.sock`
 *   bind-mounted in. That makes the container a docker **client** while
 *   the **daemon** still runs on the host. Any bind-mount source we hand
 *   the daemon is opened on the **host** filesystem — where our
 *   container-local paths like `/home/node/projects/<id>` either don't
 *   exist or point at unrelated content, so the mount silently resolves
 *   to an empty directory.
 *
 *   The Finalize runner uses this to mount a session worktree into a job
 *   container by its host-side path.
 *
 * Design choice — env-var-driven, NOT `/proc/self/mountinfo`:
 *
 *   The reviewer of PR #1074 ([8/10] item) called out two plausible
 *   approaches: parse `/proc/self/mountinfo` to auto-derive the host
 *   path, OR have operators declare the mapping via env vars. We
 *   deliberately chose the env-var approach for three reasons:
 *
 *     1. **No edge cases.** `mountinfo` has nested-mount, subdirectory
 *        bind-mount (field 4 `fsRoot` ≠ mount point), and stale-on-remount
 *        problems. A naïve prefix-replacement gets subdirectory bind
 *        mounts wrong because the host-side path needs `fsRoot` (field 4)
 *        prepended to the suffix, not just the mount-point prefix swapped.
 *
 *     2. **Operator-controlled.** Terraform / Docker Compose / Kubernetes
 *        already render the mapping at deploy time — the env var just
 *        surfaces what the operator declared, so the runtime never
 *        guesses.
 *
 *     3. **Testable.** Tests inject `hostProjectsDir` / `hostWorkspacesDir`
 *        directly without mocking `/proc`, so the helper stays a pure
 *        function.
 *
 *   The trade-off: an operator who forgets to set the env var on a
 *   container deploy gets a `null` translation + a warning, not an
 *   auto-discovered mapping. That trade-off is fine because the failure
 *   surface is loud (the wizard build fails) and the fix is one env
 *   var. Auto-detection would silently mis-resolve for any operator who
 *   used a nested or subdirectory mount layout.
 *
 * Contract:
 *
 *   - `AGENT_HUB_HOST_PROJECTS_DIR` (env): set by the deployment scripts
 *     to the host filesystem path that backs the bind-mount of the
 *     container's projects directory. On EC2 this is `<DATA_ROOT>/projects`
 *     where `DATA_ROOT` is the data root that terraform configures.
 *     When unset, projects-root translation is a no-op so dev / Electron
 *     / non-container installs are unaffected.
 *
 *   - `AGENT_HUB_CONTAINER_PROJECTS_DIR` (env, optional): the container
 *     mountpoint. Defaults to `/home/node/projects` which matches the
 *     terraform-rendered docker run.
 *
 *   - `AGENT_HUB_HOST_WORKSPACES_DIR` (env): set by the deployment
 *     scripts to the host filesystem path that backs the bind-mount of
 *     the container's per-session worktree workspaces directory. On EC2
 *     this is `<DATA_ROOT>/workspaces`. When unset, workspaces-root
 *     translation is a no-op (matches pre-PR behavior — worktrees were
 *     not bind-mounted at all, so the previous code returned `null` for
 *     these paths via the "outside the bind-mounted projects root" reason).
 *
 *   - `AGENT_HUB_CONTAINER_WORKSPACES_DIR` (env, optional): the
 *     container mountpoint for workspaces. Defaults to
 *     `/home/node/.agent-hub/workspaces`, matching {@link WORKSPACES_ROOT}
 *     in `server/worktree.ts`.
 *
 *   - `AGENT_HUB_HOST_MAC_PROJECTS_DIR` / `AGENT_HUB_CONTAINER_MAC_PROJECTS_DIR`
 *     (env, optional): second projects root for macOS dev layouts where
 *     `projects.json` stores `cwd` as `~/projects/<repo>` bind-mounted at
 *     the same absolute path inside the Hub container (local docker).
 *
 *   - {@link translateContainerPathToHost} rewrites a container path that
 *     starts with EITHER the projects root OR the workspaces root so the
 *     equivalent host path is returned. Paths under neither bind-mounted
 *     root (legacy operators who haven't redeployed the terraform
 *     user-data, plus Electron / dev installs without docker-in-docker)
 *     come back as `null` with a warning reason surfaced via
 *     `skippedReason` — the caller decides whether to continue with no
 *     `--project-directory` flag or to surface a hard error.
 *
 * Worktree case (resolved in this PR):
 *
 *   Until this PR landed, worktrees under
 *   `/home/node/.agent-hub/workspaces/` lived in the container's
 *   writable layer with NO host counterpart, so the translator returned
 *   `null` for any worktree-rooted preview. The terraform user-data
 *   now bind-mounts `<DATA_ROOT>/workspaces:/home/node/.agent-hub/workspaces`
 *   and exports `AGENT_HUB_HOST_WORKSPACES_DIR`, so session previews
 *   launched from worktrees translate correctly through this helper's
 *   second root mapping below.
 */

import { existsSync } from 'fs';

const DEFAULT_CONTAINER_PROJECTS_DIR = '/home/node/projects';
const DEFAULT_CONTAINER_WORKSPACES_DIR = '/home/node/.agent-hub/workspaces';

export interface HostPathTranslation {
  /** Container path that was passed in (unchanged). */
  readonly containerPath: string;
  /**
   * Host-side path docker daemon can resolve. `null` when translation
   * isn't possible (env unset, or `containerPath` outside any
   * bind-mounted root).
   */
  readonly hostPath: string | null;
  /**
   * Human-readable reason translation was skipped. Always set when
   * `hostPath` is `null`, so callers can log it consistently.
   */
  readonly skippedReason?: string;
  /**
   * Which root the translation matched against, when it succeeded.
   * `undefined` when `hostPath` is `null`. Exposed so callers / tests
   * can distinguish projects-root hits from workspaces-root hits without
   * re-running prefix checks.
   */
  readonly matchedRoot?: 'projects' | 'workspaces' | 'macProjects';
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
  /**
   * Override for the `AGENT_HUB_HOST_WORKSPACES_DIR` env var. Tests
   * inject this so the helper can be exercised without mutating
   * process env. Pass `null` (or leave unset) to disable workspaces-root
   * translation.
   */
  readonly hostWorkspacesDir?: string | null;
  /**
   * Override for the `AGENT_HUB_CONTAINER_WORKSPACES_DIR` env var.
   * Defaults to {@link DEFAULT_CONTAINER_WORKSPACES_DIR} when neither
   * this nor the env var is set.
   */
  readonly containerWorkspacesDir?: string | null;
  /**
   * Optional macOS `~/projects` root — host path (e.g. `/Users/you/projects`).
   */
  readonly hostMacProjectsDir?: string | null;
  /**
   * Container mount for {@link hostMacProjectsDir}. Often the same absolute
   * path on Docker Desktop so build contexts resolve in-container.
   */
  readonly containerMacProjectsDir?: string | null;
}

function trimTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.replace(/\/+$/, '');
  return p;
}

interface RootPair {
  readonly containerRoot: string;
  readonly hostRoot: string;
  readonly label: 'projects' | 'workspaces' | 'macProjects';
}

/**
 * Try translating `input` against a single (containerRoot -> hostRoot)
 * pair. Returns `null` when the input doesn't live under
 * `containerRoot`. The longest-matching pair must be chosen by the
 * caller — this helper does no prioritisation.
 */
function tryTranslateWithRoot(input: string, pair: RootPair): string | null {
  if (input === pair.containerRoot) return pair.hostRoot;
  const containerRootWithSlash = `${pair.containerRoot}/`;
  if (!input.startsWith(containerRootWithSlash)) return null;
  const suffix = input.slice(pair.containerRoot.length);
  return `${pair.hostRoot}${suffix}`;
}

function resolveRootPair(
  label: RootPair['label'],
  hostDirRaw: string | null | undefined,
  containerDirRaw: string | null | undefined,
  containerDefault: string,
): RootPair | null {
  if (!hostDirRaw || !hostDirRaw.trim()) return null;
  const containerRoot = trimTrailingSlash((containerDirRaw ?? containerDefault).trim());
  const hostRoot = trimTrailingSlash(hostDirRaw.trim());
  if (!containerRoot) return null;
  return { containerRoot, hostRoot, label };
}

/**
 * Translate a container-visible path to the equivalent host path the
 * docker daemon would see. Returns `{ hostPath: null, skippedReason }`
 * when translation isn't possible — never throws.
 *
 * Resolution order: tries the projects root first, then the workspaces
 * root. The longest matching prefix wins on a tie (defensive — the two
 * roots are disjoint in the production layout but custom env-var
 * overrides could in principle make them overlap).
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
  const containerProjectsDirRaw =
    options.containerProjectsDir !== undefined
      ? options.containerProjectsDir
      : (process.env.AGENT_HUB_CONTAINER_PROJECTS_DIR ?? null);

  const hostWorkspacesDirRaw =
    options.hostWorkspacesDir !== undefined
      ? options.hostWorkspacesDir
      : (process.env.AGENT_HUB_HOST_WORKSPACES_DIR ?? null);
  const containerWorkspacesDirRaw =
    options.containerWorkspacesDir !== undefined
      ? options.containerWorkspacesDir
      : (process.env.AGENT_HUB_CONTAINER_WORKSPACES_DIR ?? null);

  const projectsPair = resolveRootPair(
    'projects',
    hostProjectsDirRaw,
    containerProjectsDirRaw,
    DEFAULT_CONTAINER_PROJECTS_DIR,
  );
  const workspacesPair = resolveRootPair(
    'workspaces',
    hostWorkspacesDirRaw,
    containerWorkspacesDirRaw,
    DEFAULT_CONTAINER_WORKSPACES_DIR,
  );

  const hostMacProjectsDirRaw =
    options.hostMacProjectsDir !== undefined
      ? options.hostMacProjectsDir
      : (process.env.AGENT_HUB_HOST_MAC_PROJECTS_DIR ?? null);
  const containerMacProjectsDirRaw =
    options.containerMacProjectsDir !== undefined
      ? options.containerMacProjectsDir
      : (process.env.AGENT_HUB_CONTAINER_MAC_PROJECTS_DIR ?? null);
  const macProjectsPair = resolveRootPair(
    'macProjects',
    hostMacProjectsDirRaw,
    containerMacProjectsDirRaw,
    hostMacProjectsDirRaw?.trim() ?? '',
  );

  if (!projectsPair && !workspacesPair && !macProjectsPair) {
    return {
      containerPath,
      hostPath: null,
      skippedReason:
        'no host root configured (set AGENT_HUB_HOST_PROJECTS_DIR, AGENT_HUB_HOST_WORKSPACES_DIR, or AGENT_HUB_HOST_MAC_PROJECTS_DIR)',
    };
  }

  const normalisedInput = trimTrailingSlash(trimmedInput);
  const candidates: RootPair[] = [];
  if (projectsPair) candidates.push(projectsPair);
  if (workspacesPair) candidates.push(workspacesPair);
  if (macProjectsPair) candidates.push(macProjectsPair);
  // Longest-prefix wins on overlap. Stable across env-var swaps.
  candidates.sort((a, b) => b.containerRoot.length - a.containerRoot.length);

  for (const pair of candidates) {
    const hostPath = tryTranslateWithRoot(normalisedInput, pair);
    if (hostPath !== null) {
      return { containerPath, hostPath, matchedRoot: pair.label };
    }
  }

  const triedLabels = candidates.map((c) => c.label).join(' or ');
  const triedRoots = candidates.map((c) => c.containerRoot).join(', ');
  return {
    containerPath,
    hostPath: null,
    skippedReason: `path is outside the bind-mounted ${triedLabels} root (expected prefix one of: ${triedRoots})`,
  };
}
