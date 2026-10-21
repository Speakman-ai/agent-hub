/**
 * Default-branch health for the red-branch banner (web `CiRunsSection`,
 * mobile Runners screen). One copy of the fetch lifecycle so both surfaces
 * agree on it:
 *
 * - The snapshot is stored with the project it was read for and only
 *   returned for that project. Switching projects shows nothing until the
 *   new project's read succeeds, so a failed read can never leave another
 *   project's red banner (and card link) on screen.
 * - A failed refresh for the same project keeps the last snapshot.
 * - It refetches when `refreshKey` changes (a push-CI run settled) and on a
 *   fallback poll.
 * - Responses from an earlier project or an unmounted view are dropped.
 */
import {
  DEFAULT_BRANCH_HEALTH_POLL_MS,
  type DefaultBranchHealthWire,
} from '../utils/testSelectionDisplay';

export interface DefaultBranchHealthSnapshot {
  projectId: string;
  health: DefaultBranchHealthWire | null;
}

/** The snapshot's health when it belongs to `projectId`, else null. */
export function healthForProject(
  snapshot: DefaultBranchHealthSnapshot | null,
  projectId: string,
): DefaultBranchHealthWire | null {
  return snapshot && projectId && snapshot.projectId === projectId ? snapshot.health : null;
}

function asHealth(raw: unknown): DefaultBranchHealthWire | null {
  return raw && typeof raw === 'object' && Array.isArray((raw as { failures?: unknown }).failures)
    ? (raw as DefaultBranchHealthWire)
    : null;
}

type Hooks = {
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useState: <T>(initial: T) => [T, (next: T) => void];
};

export interface UseDefaultBranchHealthOptions {
  /** Refetch whenever this changes. */
  refreshKey?: string;
  /** Fallback poll; 0 disables it. */
  pollMs?: number;
}

// Web and native install different React versions. Use the renderer's own hooks.
export function createUseDefaultBranchHealth({ useEffect, useState }: Hooks) {
  return function useDefaultBranchHealth(
    projectId: string,
    fetchHealth: (projectId: string) => Promise<unknown>,
    { refreshKey = '', pollMs = DEFAULT_BRANCH_HEALTH_POLL_MS }: UseDefaultBranchHealthOptions = {},
  ): DefaultBranchHealthWire | null {
    const [snapshot, setSnapshot] = useState<DefaultBranchHealthSnapshot | null>(null);
    useEffect(() => {
      if (!projectId) return undefined;
      let cancelled = false;
      const load = () => {
        // A synchronous throw from the client must not take the view down.
        Promise.resolve()
          .then(() => fetchHealth(projectId))
          .then((raw) => {
            if (!cancelled) setSnapshot({ projectId, health: asHealth(raw) });
          })
          .catch(() => {
            // Same project: keep the last snapshot. Another project's
            // snapshot is never returned (healthForProject).
          });
      };
      load();
      const timer = pollMs > 0 ? setInterval(load, pollMs) : null;
      return () => {
        cancelled = true;
        if (timer) clearInterval(timer);
      };
      // fetchHealth is a stable API client method, so it is not a dependency.
    }, [projectId, refreshKey, pollMs]);
    return healthForProject(snapshot, projectId);
  };
}
