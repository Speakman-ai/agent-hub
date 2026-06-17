import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { hasCommittableChangesFromReady } from '../utils/changesReady';

const POLL_MS = 15_000;

/**
 * Whether the active session has committable worktree changes.
 * Mirrors the web FinalizeButton worktree poll + changes-ready fallback.
 */
export function useSessionCommittable(sessionId, { pendingChanges = null } = {}) {
  const [worktreeCommittable, setWorktreeCommittable] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setWorktreeCommittable(false);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      api
        .getSessionWorktreeChanges(sessionId)
        .then((data) => {
          if (!cancelled) setWorktreeCommittable(Boolean(data?.committable));
        })
        .catch(() => {
          if (!cancelled) setWorktreeCommittable(false);
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  return worktreeCommittable || hasCommittableChangesFromReady(pendingChanges);
}
