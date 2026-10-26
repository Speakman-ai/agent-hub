import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, List, SquareKanban } from 'lucide-react';
import { api, type QaPlanListItemWire, type QaPlanStatus, type QaVerdict } from '../utils/api';
import { QA_STATUSES, VERDICT_CLASS, VERDICT_LABELS } from '../utils/qaLabels';
import { LinkChips, type LinkProps } from './QaLinkChips';
import QaPlanDetail from './QaPlanDetail';

export { QA_STATUSES };

type ViewMode = 'list' | 'board';

const VIEW_MODE_KEY = 'agenthub.qa.viewMode';

/** Plans bucketed by status, each bucket keeping the server's newest-first order. */
export function groupPlansByStatus(
  plans: QaPlanListItemWire[],
): Record<QaPlanStatus, QaPlanListItemWire[]> {
  const out: Record<QaPlanStatus, QaPlanListItemWire[]> = { new: [], in_progress: [], done: [] };
  for (const p of plans) out[p.status]?.push(p);
  return out;
}

export function targetHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Short text for the latest run: "Run 2 running · 1 pass, 1 fail", or "Not run". */
export function latestRunLabel(plan: QaPlanListItemWire): string {
  const run = plan.summary.latestRun;
  if (!run) return 'Not run';
  const parts = (Object.keys(VERDICT_LABELS) as QaVerdict[])
    .filter((v) => run.verdicts[v] > 0)
    .map((v) => `${run.verdicts[v]} ${VERDICT_LABELS[v]}`);
  const head = `Run ${run.iteration} ${run.status}`;
  return parts.length ? `${head} · ${parts.join(', ')}` : head;
}

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

function VerdictSummary({ plan }: { plan: QaPlanListItemWire }) {
  const run = plan.summary.latestRun;
  if (!run) return <span className="text-gray-500">Not run</span>;
  const verdicts = (Object.keys(VERDICT_LABELS) as QaVerdict[]).filter((v) => run.verdicts[v] > 0);
  return (
    <span title={latestRunLabel(plan)} className="inline-flex flex-wrap items-center gap-x-2">
      <span className="text-gray-400">
        Run {run.iteration} {run.status}
      </span>
      {verdicts.map((v) => (
        <span key={v} className={VERDICT_CLASS[v]}>
          {run.verdicts[v]} {VERDICT_LABELS[v]}
        </span>
      ))}
    </span>
  );
}

type PlanItemProps = { plan: QaPlanListItemWire; onOpenPlan: (planId: string) => void } & LinkProps;

function PlanRow({ plan, onOpenPlan, ...links }: PlanItemProps) {
  return (
    <li
      data-testid={`qa-plan-row-${plan.id}`}
      className="flex flex-col gap-1 border-b border-gray-800 px-3 py-2 last:border-b-0 md:flex-row md:items-center md:gap-4"
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-testid={`qa-plan-open-${plan.id}`}
          onClick={() => onOpenPlan(plan.id)}
          className="block max-w-full truncate text-left text-sm text-gray-100 hover:text-blue-300"
        >
          {plan.title}
        </button>
        <div className="truncate text-xs text-gray-500" title={plan.targetUrl}>
          {targetHost(plan.targetUrl)}
        </div>
      </div>
      <div className="text-xs">
        <VerdictSummary plan={plan} />
      </div>
      <LinkChips epic={plan.summary.epic} card={plan.summary.card} {...links} />
    </li>
  );
}

function PlanCard({ plan, onOpenPlan, ...links }: PlanItemProps) {
  return (
    <div
      data-testid={`qa-plan-card-${plan.id}`}
      className="flex flex-col gap-1.5 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2"
    >
      <button
        type="button"
        data-testid={`qa-plan-open-${plan.id}`}
        onClick={() => onOpenPlan(plan.id)}
        className="block max-w-full text-left text-sm text-gray-100 hover:text-blue-300"
      >
        {plan.title}
      </button>
      <div className="truncate text-xs text-gray-500" title={plan.targetUrl}>
        {targetHost(plan.targetUrl)}
      </div>
      <div className="text-xs">
        <VerdictSummary plan={plan} />
      </div>
      <LinkChips epic={plan.summary.epic} card={plan.summary.card} {...links} />
    </div>
  );
}

export interface QaPageProps extends LinkProps {
  projectId: string;
  projectName?: string;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
}

export default function QaPage({
  projectId,
  projectName,
  onOpenEpic,
  onOpenCard,
  onOpenSession,
}: QaPageProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [plans, setPlans] = useState<QaPlanListItemWire[]>([]);
  const [counts, setCounts] = useState<Record<QaPlanStatus, number>>({
    new: 0,
    in_progress: 0,
    done: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<QaPlanStatus>('new');
  const [viewMode, setViewModeState] = useState<ViewMode>(readViewMode);

  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // Storage unavailable: the toggle still works for this page load.
    }
  };

  // Every load takes a sequence number; only the newest may write state, so a
  // slow response for a previous project or an older qa_update refresh can
  // never overwrite newer data.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api.listQaPlans(projectId);
      if (seq !== requestSeq.current) return;
      setPlans(data.plans);
      setCounts(data.counts);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load QA plans');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedPlanId(null);
    setPlans([]);
    setCounts({ new: 0, in_progress: 0, done: 0 });
    setError(null);
    setLoading(true);
    void load();
    return () => {
      // Invalidate whatever is in flight when the project changes or we unmount.
      requestSeq.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) void load();
    };
    window.addEventListener('qa_update', onUpdate);
    return () => window.removeEventListener('qa_update', onUpdate);
  }, [load, projectId]);

  const grouped = useMemo(() => groupPlansByStatus(plans), [plans]);

  if (selectedPlanId) {
    return (
      <QaPlanDetail
        key={selectedPlanId}
        projectId={projectId}
        planId={selectedPlanId}
        onBack={() => setSelectedPlanId(null)}
        onOpenEpic={onOpenEpic}
        onOpenCard={onOpenCard}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-4" data-testid="qa-page">
      <div className="flex items-center gap-3">
        <ClipboardCheck size={20} className="text-gray-400" />
        <h1 className="text-lg font-semibold text-gray-100">
          QA{projectName ? <span className="text-gray-500"> · {projectName}</span> : null}
        </h1>
        <div
          role="group"
          aria-label="QA view"
          className="ml-auto inline-flex overflow-hidden rounded-md border border-gray-700"
        >
          {(
            [
              { key: 'list', label: 'List', Icon: List },
              { key: 'board', label: 'Board', Icon: SquareKanban },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              data-testid={`qa-view-${key}`}
              aria-pressed={viewMode === key}
              onClick={() => setViewMode(key)}
              className={`inline-flex items-center gap-1 px-2 py-1 text-xs ${
                viewMode === key
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {viewMode === 'list' ? (
        <>
          <div
            role="tablist"
            aria-label="QA plan status"
            className="flex gap-1 border-b border-gray-800"
          >
            {QA_STATUSES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                data-testid={`qa-tab-${key}`}
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                  tab === key
                    ? 'border-blue-500 text-white'
                    : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
                <span className="ml-1.5 rounded-full bg-gray-800 px-1.5 text-[11px] text-gray-400">
                  {counts[key]}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : grouped[tab].length === 0 ? (
            <div className="text-sm text-gray-500" data-testid="qa-empty">
              No plans here.
            </div>
          ) : (
            <ul className="rounded-lg border border-gray-800" data-testid="qa-plan-list">
              {grouped[tab].map((p) => (
                <PlanRow
                  key={p.id}
                  plan={p}
                  onOpenPlan={setSelectedPlanId}
                  onOpenEpic={onOpenEpic}
                  onOpenCard={onOpenCard}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-3">
          {QA_STATUSES.map(({ key, label }) => (
            <section
              key={key}
              data-testid={`qa-column-${key}`}
              className="flex min-h-0 flex-col rounded-lg border border-gray-800 bg-gray-900/40"
            >
              <header className="flex items-center gap-2 border-b border-gray-800 px-3 py-2 text-sm text-gray-300">
                {label}
                <span className="rounded-full bg-gray-800 px-1.5 text-[11px] text-gray-400">
                  {counts[key]}
                </span>
              </header>
              <div className="flex flex-col gap-2 overflow-y-auto p-2">
                {grouped[key].map((p) => (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    onOpenPlan={setSelectedPlanId}
                    onOpenEpic={onOpenEpic}
                    onOpenCard={onOpenCard}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
