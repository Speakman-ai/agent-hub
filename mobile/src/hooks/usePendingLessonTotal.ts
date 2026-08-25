import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import {
  createPendingLessonCountsState,
  reconcilePendingLessonProjects,
  applyPendingLessonSuccess,
  applyPendingLessonFailure,
  totalPendingLessons,
} from '@shared/utils/pendingLessonCounts';

/**
 * Total pending skill-lessons across all projects, driving the mobile drawer
 * Skills badge. Refetches every project on load and whenever `refreshKey`
 * changes (bumped by the `skill_improvement_update` broadcast). A failed
 * project fetch PRESERVES its last known count rather than dropping to 0, so a
 * single transient error never erases the total; departed projects are pruned
 * so the sum stays accurate after an org switch. See @shared/utils/
 * pendingLessonCounts for the fetch-lifecycle contract.
 */
export function usePendingLessonTotal(
  projects: Array<{ id?: string | null }> | null | undefined,
  refreshKey: number,
): number {
  const [total, setTotal] = useState(0);
  const stateRef = useRef(createPendingLessonCountsState());

  useEffect(() => {
    const state = stateRef.current;
    const toFetch = reconcilePendingLessonProjects(
      state,
      (projects ?? []).map((p) => p?.id),
      'refresh',
    );
    // Reflect pruning of departed projects immediately.
    setTotal(totalPendingLessons(state));
    if (toFetch.length === 0) return;
    let cancelled = false;
    for (const { projectId: pid, token } of toFetch) {
      api
        .getSkillImprovements(pid, 'pending')
        .then((data: any) => {
          if (cancelled) return;
          const count = Array.isArray(data?.improvements) ? data.improvements.length : 0;
          if (applyPendingLessonSuccess(state, pid, token, count)) {
            setTotal(totalPendingLessons(state));
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (applyPendingLessonFailure(state, pid, token)) {
            setTotal(totalPendingLessons(state));
          }
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
  }, [projects, refreshKey]);

  return total;
}
