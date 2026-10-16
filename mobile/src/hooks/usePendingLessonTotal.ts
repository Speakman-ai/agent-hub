import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import {
  createPendingLessonCountsState,
  reconcilePendingLessonProjects,
  applyPendingLessonSuccess,
  applyPendingLessonFailure,
  pendingLessonCountsSnapshot,
  totalPendingLessons,
} from '@shared/utils/pendingLessonCounts';

export type PendingLessonBadge = {
  total: number;
  counts: Record<string, number>;
};

/**
 * Pending skill-lessons per project, plus the cross-project total.
 * `counts` drives each project's Skills row in the sidebar (same as web).
 * `total` is their sum. Refetches every project on load and whenever
 * `refreshKey` changes. A failed project fetch keeps its last known count;
 * departed projects are pruned. See @shared/utils/pendingLessonCounts.
 */
export function usePendingLessonTotal(
  projects: Array<{ id?: string | null }> | null | undefined,
  refreshKey: number,
): PendingLessonBadge {
  const [badge, setBadge] = useState<PendingLessonBadge>({ total: 0, counts: {} });
  const stateRef = useRef(createPendingLessonCountsState());

  const publish = () => {
    const state = stateRef.current;
    setBadge({
      total: totalPendingLessons(state),
      counts: pendingLessonCountsSnapshot(state),
    });
  };

  useEffect(() => {
    const state = stateRef.current;
    const toFetch = reconcilePendingLessonProjects(
      state,
      (projects ?? []).map((p) => p?.id),
      'refresh',
    );
    // Reflect pruning of departed projects immediately.
    publish();
    if (toFetch.length === 0) return;
    let cancelled = false;
    for (const { projectId: pid, token } of toFetch) {
      api
        .getSkillImprovements(pid, 'pending')
        .then((data: any) => {
          if (cancelled) return;
          const count = Array.isArray(data?.improvements) ? data.improvements.length : 0;
          if (applyPendingLessonSuccess(state, pid, token, count)) publish();
        })
        .catch(() => {
          if (cancelled) return;
          if (applyPendingLessonFailure(state, pid, token)) publish();
        });
    }
    return () => {
      cancelled = true;
      // In-flight requests for this run were neither applied nor resolved;
      // clear their in-flight marker so the next run retries them.
      for (const { projectId: pid, token } of toFetch) {
        applyPendingLessonFailure(state, pid, token);
      }
    };
    // publish closes over stateRef, which is stable.
  }, [projects, refreshKey]);

  return badge;
}
