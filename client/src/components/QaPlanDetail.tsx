import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, MessageSquare } from 'lucide-react';
import { api, type QaCaseWire, type QaPlanDetailWire, type QaRunWire } from '../utils/api';
import {
  QA_STATUS_LABELS,
  RUN_STATUS_CLASS,
  VERDICT_CLASS,
  VERDICT_LABELS,
} from '../utils/qaLabels';
import { formatDateTime, parseDate } from '../utils/time';
import { LinkChips, type LinkProps } from './QaLinkChips';

type LatestVerdict = QaCaseWire['latestVerdict'];

/**
 * Text for a case's latest verdict cell. A verdict recorded against an older
 * case version is still shown, but flagged so nobody reads it as current.
 */
export function caseVerdictLabel(latest: LatestVerdict): string {
  if (!latest) return 'Not run';
  const label = VERDICT_LABELS[latest.verdict];
  return latest.current
    ? `${label} (run ${latest.iteration})`
    : `${label} (run ${latest.iteration}, case edited since)`;
}

/** "3m 12s" style duration, or null when the run has not started. */
export function runDuration(run: QaRunWire, now: Date = new Date()): string | null {
  const start = parseDate(run.startedAt);
  if (!start || isNaN(start.getTime())) return null;
  const end = parseDate(run.finishedAt) ?? now;
  const totalSec = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function VerdictCell({ latest }: { latest: LatestVerdict }) {
  if (!latest) {
    return (
      <span className="text-gray-500" data-testid="qa-verdict">
        Not run
      </span>
    );
  }
  return (
    <span
      data-testid="qa-verdict"
      data-verdict={latest.verdict}
      data-current={latest.current ? 'true' : 'false'}
      title={caseVerdictLabel(latest)}
      className="inline-flex items-center gap-1.5"
    >
      <span
        className={latest.current ? VERDICT_CLASS[latest.verdict] : 'text-gray-500 line-through'}
      >
        {VERDICT_LABELS[latest.verdict]}
      </span>
      <span className="text-gray-500">run {latest.iteration}</span>
      {!latest.current && (
        <span className="rounded bg-gray-800 px-1 text-[10px] text-amber-300">stale</span>
      )}
    </span>
  );
}

function CaseTable({ cases, approved }: { cases: QaCaseWire[]; approved: boolean }) {
  if (cases.length === 0) {
    return (
      <div className="text-sm text-gray-500" data-testid="qa-cases-empty">
        No cases yet. The QA agent proposes cases in the plan&apos;s session
        {approved ? '.' : '; approve the plan once the list looks right.'}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-left text-sm" data-testid="qa-case-table">
        <thead className="border-b border-gray-800 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-normal">#</th>
            <th className="px-3 py-2 font-normal">Case</th>
            <th className="px-3 py-2 font-normal">Expected</th>
            <th className="px-3 py-2 font-normal">Latest verdict</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr
              key={c.id}
              data-testid={`qa-case-row-${c.id}`}
              className="border-b border-gray-800 align-top last:border-b-0"
            >
              <td className="px-3 py-2 text-gray-500">{i + 1}</td>
              <td className="px-3 py-2">
                <div className="text-gray-100">{c.title}</div>
                {c.steps && (
                  <div className="mt-0.5 whitespace-pre-wrap text-xs text-gray-500">{c.steps}</div>
                )}
              </td>
              <td className="whitespace-pre-wrap px-3 py-2 text-xs text-gray-400">
                {c.expected || <span className="text-gray-600">None given</span>}
              </td>
              <td className="px-3 py-2 text-xs">
                <VerdictCell latest={c.latestVerdict ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunHistory({
  runs,
  approved,
  onOpenSession,
}: {
  runs: QaRunWire[];
  approved: boolean;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="text-sm text-gray-500" data-testid="qa-runs-empty">
        No runs yet.{' '}
        {approved
          ? 'Start a run to record a verdict for each case.'
          : 'Runs start once the plan is approved.'}
      </div>
    );
  }
  return (
    <ul className="rounded-lg border border-gray-800" data-testid="qa-run-list">
      {runs.map((r) => {
        const duration = runDuration(r);
        return (
          <li
            key={r.id}
            data-testid={`qa-run-row-${r.id}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-800 px-3 py-2 text-xs last:border-b-0"
          >
            <span className="text-sm text-gray-100">Run {r.iteration}</span>
            <span className="text-gray-400">
              {r.scope === 'failed_only' ? 'Failed only' : 'Full'}
            </span>
            <span className={RUN_STATUS_CLASS[r.status]} data-testid="qa-run-status">
              {r.status}
            </span>
            <span className="text-gray-500">
              {r.startedAt ? `Started ${formatDateTime(r.startedAt)}` : 'Not started'}
              {duration ? ` · ${duration}${r.finishedAt ? '' : ' so far'}` : ''}
            </span>
            {r.sessionId && (
              <button
                type="button"
                data-testid="qa-run-session"
                className="ml-auto inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 disabled:text-gray-500"
                disabled={!onOpenSession}
                onClick={() => onOpenSession?.(r.sessionAgentId, r.sessionId!)}
              >
                <MessageSquare size={12} />
                Session
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface QaPlanDetailProps extends LinkProps {
  projectId: string;
  planId: string;
  onBack: () => void;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
}

export default function QaPlanDetail({
  projectId,
  planId,
  onBack,
  onOpenEpic,
  onOpenCard,
  onOpenSession,
}: QaPlanDetailProps) {
  const [detail, setDetail] = useState<QaPlanDetailWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // Same newest-wins sequencing as the list: a slow response for a previous
  // plan or an older qa_update refresh never overwrites newer data.
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api.getQaPlan(projectId, planId);
      if (seq !== requestSeq.current) return;
      setDetail(data);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load QA plan');
    }
  }, [projectId, planId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent<{ projectId?: string; planId?: string }>).detail;
      if (d?.projectId && d.projectId !== projectId) return;
      if (d?.planId && d.planId !== planId) return;
      void load();
    };
    window.addEventListener('qa_update', onUpdate);
    return () => window.removeEventListener('qa_update', onUpdate);
  }, [load, projectId, planId]);

  const plan = detail?.plan;

  return (
    <div className="flex h-full flex-col gap-4" data-testid="qa-plan-detail">
      <div>
        <button
          type="button"
          onClick={onBack}
          data-testid="qa-detail-back"
          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft size={12} />
          All plans
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {!plan ? (
        !error && <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-gray-100">{plan.title}</h1>
              <span
                data-testid="qa-detail-status"
                className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300"
              >
                {QA_STATUS_LABELS[plan.status]}
              </span>
              <span
                data-testid="qa-detail-approval"
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  plan.approved ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'
                }`}
                title={
                  plan.approved && plan.approvedAt
                    ? `Approved ${formatDateTime(plan.approvedAt)}`
                    : undefined
                }
              >
                {plan.approved ? 'Approved' : 'Not approved'}
              </span>
              {plan.signedOffAt && (
                <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300">
                  Signed off {formatDateTime(plan.signedOffAt)}
                </span>
              )}
            </div>
            <a
              href={plan.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="qa-detail-target"
              className="inline-flex w-fit max-w-full items-center gap-1 truncate text-sm text-blue-400 hover:text-blue-300"
            >
              <span className="truncate">{plan.targetUrl}</span>
              <ExternalLink size={12} className="flex-shrink-0" />
            </a>
            <LinkChips
              epic={detail.links.epic}
              card={detail.links.card}
              onOpenEpic={onOpenEpic}
              onOpenCard={onOpenCard}
            />
            {plan.goal && <p className="whitespace-pre-wrap text-sm text-gray-400">{plan.goal}</p>}
          </header>

          {!plan.approved && (
            <div
              data-testid="qa-detail-unapproved"
              className="rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200"
            >
              This plan is not approved. Cases can still change, and runs are refused until a human
              approves the case list.
            </div>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-gray-300">
              Cases <span className="text-gray-500">{detail.cases.length}</span>
            </h2>
            <CaseTable cases={detail.cases} approved={plan.approved} />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-gray-300">Run history</h2>
            <RunHistory runs={detail.runs} approved={plan.approved} onOpenSession={onOpenSession} />
          </section>
        </>
      )}
    </div>
  );
}
