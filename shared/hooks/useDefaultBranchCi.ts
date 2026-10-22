/**
 * Latest CI-on-push run for the Repository page's default-branch CI badge
 * (web `RepositoryPage`, mobile `RepositoryScreen`). Fetches only while
 * `enabled`, polls faster while a run is in flight, never has two requests
 * in flight at once, and never returns a snapshot read for a different
 * project.
 */
import {
  DEFAULT_BRANCH_CI_POLL_MS,
  DEFAULT_BRANCH_CI_RUNNING_POLL_MS,
  defaultBranchCiStatus,
  latestPushRun,
  type DefaultBranchCiStatus,
} from '../utils/defaultBranchCiStatus';

type Hooks = {
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useState: <T>(initial: T) => [T, (next: T) => void];
};

interface Snapshot {
  projectId: string;
  status: DefaultBranchCiStatus;
}

// Web and native install different React versions. Use the renderer's own hooks.
export function createUseDefaultBranchCi({ useEffect, useState }: Hooks) {
  return function useDefaultBranchCi(
    projectId: string,
    enabled: boolean,
    fetchRuns: (projectId: string) => Promise<unknown>,
  ): DefaultBranchCiStatus | null {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const running = snapshot?.projectId === projectId && snapshot.status.tone === 'running';
    useEffect(() => {
      if (!projectId || !enabled) return undefined;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const delay = running ? DEFAULT_BRANCH_CI_RUNNING_POLL_MS : DEFAULT_BRANCH_CI_POLL_MS;
      // Serialized: the next poll is scheduled only after the previous one
      // settles, so a slow older response can never land after a newer one.
      const load = () => {
        Promise.resolve()
          .then(() => fetchRuns(projectId))
          .then((raw) => {
            if (!cancelled) {
              setSnapshot({ projectId, status: defaultBranchCiStatus(latestPushRun(raw)) });
            }
          })
          .catch(() => {
            // Keep the last snapshot for this project.
          })
          .finally(() => {
            if (!cancelled) timer = setTimeout(load, delay);
          });
      };
      load();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
      // fetchRuns is a stable API client method, so it is not a dependency.
    }, [projectId, enabled, running]);
    if (!enabled || !snapshot || snapshot.projectId !== projectId) return null;
    return snapshot.status;
  };
}
