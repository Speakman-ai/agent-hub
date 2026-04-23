import { CheckCircle2, AlertTriangle, XCircle, Circle, MinusCircle } from 'lucide-react';
import { scoreBand, findingsByCategory, maxSeverity } from '../utils/auditReport.js';

/**
 * AuditReport — readable rendering of a normalized audit report.
 *
 * Props:
 *   - report: normalized shape from `normalizeReport()`. If null, renders
 *     a neutral placeholder so the component is safe to mount while the
 *     async load is in-flight.
 *   - onRefresh: optional callback — renders a "Refresh" action when supplied.
 */
export default function AuditReport({ report, onRefresh }) {
  if (!report) {
    return (
      <section
        className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-6 text-sm text-gray-400"
        data-testid="audit-report-empty"
      >
        Audit report not available.
      </section>
    );
  }

  const band = scoreBand(report.score);
  const grouped = findingsByCategory(report.findings);

  return (
    <section
      aria-label="Post-scaffold audit report"
      data-testid="audit-report"
      data-score-band={band}
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <ScoreHeader score={report.score} band={band} onRefresh={onRefresh} />
      <CategoryList categories={report.categories} grouped={grouped} />
      <FindingsList findings={report.findings} />
      <GapsList gaps={report.gaps} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Score header                                                        */
/* ------------------------------------------------------------------ */

function ScoreHeader({ score, band, onRefresh }) {
  const tone =
    band === 'green'
      ? 'bg-emerald-900/50 border-emerald-700 text-emerald-200'
      : band === 'amber'
        ? 'bg-amber-900/50 border-amber-700 text-amber-200'
        : band === 'red'
          ? 'bg-red-900/50 border-red-700 text-red-200'
          : 'bg-gray-800 border-gray-700 text-gray-300';
  const label =
    band === 'green'
      ? 'Ready'
      : band === 'amber'
        ? 'Needs work'
        : band === 'red'
          ? 'Not ready'
          : 'Unknown';
  return (
    <header className="flex items-center gap-3 border-b border-gray-800 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase tracking-wide text-gray-500">Readiness</div>
        <div className="flex items-baseline gap-2">
          <span
            className="text-2xl font-semibold tabular-nums text-white"
            data-testid="audit-score-value"
          >
            {score == null ? '—' : score}
          </span>
          <span className="text-xs text-gray-500">{score == null ? '' : '/ 100'}</span>
        </div>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${tone}`}
        data-testid="audit-score-band"
      >
        {label}
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2"
          data-testid="audit-refresh"
        >
          Refresh
        </button>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Category list                                                       */
/* ------------------------------------------------------------------ */

function CategoryList({ categories, grouped }) {
  if (!categories.length) {
    return (
      <div className="px-4 py-3 text-xs text-gray-500" data-testid="audit-categories-empty">
        No categories in this report.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-gray-800" data-testid="audit-categories">
      {categories.map((cat) => (
        <CategoryRow key={cat.id} category={cat} findings={grouped.get(cat.id) || []} />
      ))}
    </ul>
  );
}

function CategoryRow({ category, findings }) {
  const badge = maxSeverity(findings);
  return (
    <li
      className="flex items-center gap-3 px-4 py-2.5 text-sm"
      data-testid={`audit-cat-${category.id}`}
      data-status={category.status}
    >
      <StatusIcon status={category.status} />
      <div className="flex-1 min-w-0">
        <div className="text-gray-100">{category.label}</div>
        {category.summary && (
          <div className="text-xs text-gray-500 truncate">{category.summary}</div>
        )}
      </div>
      {badge && (
        <span
          className={`text-[11px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityBadgeTone(
            badge,
          )}`}
          data-testid={`audit-cat-${category.id}-badge`}
        >
          {findings.length} {badge}
        </span>
      )}
    </li>
  );
}

function StatusIcon({ status }) {
  const common = 'shrink-0';
  switch (status) {
    case 'ok':
      return <CheckCircle2 size={18} className={`${common} text-emerald-400`} aria-label="ok" />;
    case 'warn':
      return (
        <AlertTriangle size={18} className={`${common} text-amber-400`} aria-label="warning" />
      );
    case 'fail':
      return <XCircle size={18} className={`${common} text-red-400`} aria-label="failed" />;
    case 'na':
    default:
      return (
        <MinusCircle size={18} className={`${common} text-gray-500`} aria-label="not applicable" />
      );
  }
}

function severityBadgeTone(sev) {
  switch (sev) {
    case 'error':
      return 'border-red-700 text-red-200 bg-red-950/50';
    case 'warn':
      return 'border-amber-700 text-amber-200 bg-amber-950/50';
    default:
      return 'border-gray-700 text-gray-300 bg-gray-900/50';
  }
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

function FindingsList({ findings }) {
  if (!findings.length) return null;
  return (
    <section
      aria-label="Audit findings"
      className="border-t border-gray-800 px-4 py-3"
      data-testid="audit-findings"
    >
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Findings</h3>
      <ul className="space-y-1.5">
        {findings.map((f) => (
          <li
            key={f.id}
            className="flex items-start gap-2 text-[13px]"
            data-testid={`audit-finding-${f.id}`}
            data-severity={f.severity}
          >
            <FindingIcon severity={f.severity} />
            <div className="flex-1 min-w-0">
              <div className="text-gray-200 break-words">{f.message}</div>
              {f.hint && (
                <div className="text-xs text-gray-500">
                  <span className="font-medium">Hint:</span> {f.hint}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FindingIcon({ severity }) {
  const common = 'shrink-0 mt-0.5';
  switch (severity) {
    case 'error':
      return <XCircle size={14} className={`${common} text-red-400`} aria-label="error" />;
    case 'warn':
      return <AlertTriangle size={14} className={`${common} text-amber-400`} aria-label="warn" />;
    case 'info':
    default:
      return <Circle size={14} className={`${common} text-gray-500`} aria-label="info" />;
  }
}

/* ------------------------------------------------------------------ */
/* Gaps                                                                */
/* ------------------------------------------------------------------ */

function GapsList({ gaps }) {
  if (!gaps.length) return null;
  return (
    <section
      aria-label="Audit gaps"
      className="border-t border-gray-800 px-4 py-3"
      data-testid="audit-gaps"
    >
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Gaps</h3>
      <ul className="space-y-1.5 text-[13px]">
        {gaps.map((g) => (
          <li key={g.id} className="flex items-start gap-2" data-testid={`audit-gap-${g.id}`}>
            <Circle size={14} className="shrink-0 mt-0.5 text-gray-500" aria-label="gap" />
            <div className="flex-1 min-w-0">
              <div className="text-gray-200">{g.label}</div>
              {g.hint && <div className="text-xs text-gray-500">{g.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
