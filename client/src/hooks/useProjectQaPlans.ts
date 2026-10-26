import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type QaPlanListItemWire } from '../utils/api';
import { indexQaPlansByLink, type QaPlansByLink } from '../utils/qaLinks';

/**
 * Every QA plan in a project, indexed by linked card and epic, for the badges
 * on the board and on epic/card detail. Refreshes on the `qa_update` window
 * event App.tsx bridges from the WebSocket. A failed load leaves the badges
 * empty rather than surfacing an error on screens that are not about QA.
 */
export function useProjectQaPlans(projectId: string | null | undefined): QaPlansByLink {
  const [plans, setPlans] = useState<QaPlanListItemWire[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    setPlans([]);
    if (!projectId || typeof api.listQaPlans !== 'function') return;
    const load = () => {
      const mine = ++seq.current;
      Promise.resolve()
        .then(() => api.listQaPlans(projectId))
        .then((data) => {
          if (mine === seq.current) setPlans(Array.isArray(data?.plans) ? data.plans : []);
        })
        .catch(() => {
          if (mine === seq.current) setPlans([]);
        });
    };
    load();
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) load();
    };
    window.addEventListener('qa_update', onUpdate);
    return () => {
      seq.current += 1;
      window.removeEventListener('qa_update', onUpdate);
    };
  }, [projectId]);

  return useMemo(() => indexQaPlansByLink(plans), [plans]);
}
