import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileDiff,
  GitCommit,
  MessageSquare,
} from 'lucide-react';
import { parseFinalizeRunSummaryMetadata } from '../../../utils/finalizeTimeline';
import { relativeTime } from '../../../utils/time';

function formatAnchor(finding: any) {
  if (finding.lineStart == null) return 'file-level';
  if (finding.lineEnd == null || finding.lineEnd === finding.lineStart) {
    return `L${finding.lineStart}`;
  }
  return `L${finding.lineStart}-${finding.lineEnd}`;
}

function DiffStatLine({ meta }: any) {
  const parts = [];
  if (meta.filesChanged != null) {
    parts.push(
      <span key="files" className="text-slate-400">
        {meta.filesChanged} {meta.filesChanged === 1 ? 'file' : 'files'}
      </span>,
    );
  }
  if (meta.insertions != null) {
    parts.push(
      <span key="add" className="text-emerald-400">
        +{meta.insertions}
      </span>,
    );
  }
  if (meta.deletions != null) {
    parts.push(
      <span key="del" className="text-rose-400">
        -{meta.deletions}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div
      data-testid="finalize-summary-diffstat"
      className="flex items-center gap-2 font-mono text-[11px]"
    >
      {parts}
    </div>
  );
}

function Section({ icon: Icon, title, count, children, testId }: any) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section
      data-testid={testId}
      className="rounded border border-slate-700 bg-slate-800/40 overflow-hidden"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-slate-800"
        onClick={() => setCollapsed((c: boolean) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight size={14} className="text-slate-500" />
        ) : (
          <ChevronDown size={14} className="text-slate-500" />
        )}
        <Icon size={14} className="text-slate-500" />
        <span>{title}</span>
        {count != null ? <span className="ml-auto text-[10px] text-slate-500">{count}</span> : null}
      </button>
      {!collapsed ? (
        <div className="border-t border-slate-700/60 px-3 py-2 text-xs text-slate-300">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default function FinalizeRunSummaryBlock({ message }: any) {
  const meta = useMemo(() => parseFinalizeRunSummaryMetadata(message.metadata), [message.metadata]);

  const roundsWithFindings = useMemo(
    () => (meta?.reviewRounds ?? []).filter((r: any) => r.findings.length > 0),
    [meta?.reviewRounds],
  );

  if (!meta) return null;

  const approved = meta.finalVerdict === 'approved';

  return (
    <div
      className="flex justify-center mb-4"
      data-testid="finalize-run-summary-block"
      aria-label="Finalize summary"
    >
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-slate-900/50 border border-slate-700/60 rounded-xl px-4 py-3">
        <header className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium text-slate-200">Finalize summary</span>
          {meta.finalVerdict ? (
            <span
              data-testid="finalize-summary-verdict"
              data-verdict={meta.finalVerdict}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                approved ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'
              }`}
            >
              {approved ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
              {approved ? 'Review approved' : 'Changes requested'}
            </span>
          ) : null}
        </header>

        {meta.summary ? (
          <p
            data-testid="finalize-summary-prose"
            className="mb-3 whitespace-pre-wrap break-words text-xs text-slate-300"
          >
            {meta.summary}
          </p>
        ) : null}

        <div className="space-y-2">
          <Section
            testId="finalize-summary-changes"
            icon={GitCommit}
            title="What changed"
            count={meta.commits.length ? `${meta.commits.length} commits` : null}
          >
            <DiffStatLine meta={meta} />
            {meta.commits.length ? (
              <ul className="mt-1 space-y-0.5">
                {meta.commits.map((subject: string, i: number) => (
                  <li key={`${i}-${subject}`} className="break-words">
                    <span className="text-slate-500">·</span> {subject}
                  </li>
                ))}
                {meta.truncatedCommits > 0 ? (
                  <li className="text-slate-500">
                    …and {meta.truncatedCommits} more commit
                    {meta.truncatedCommits === 1 ? '' : 's'}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-slate-500">No commits found on the branch.</p>
            )}
            {meta.diffStat ? (
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
                {meta.diffStat}
              </pre>
            ) : null}
          </Section>

          <Section
            testId="finalize-summary-review"
            icon={MessageSquare}
            title="What the reviewer pointed out"
            count={
              meta.reviewRounds.length
                ? `${meta.totalFindings} finding${meta.totalFindings === 1 ? '' : 's'}`
                : null
            }
          >
            {meta.reviewNotes ? (
              <p className="mb-2 whitespace-pre-wrap break-words">{meta.reviewNotes}</p>
            ) : null}
            {meta.reviewRounds.length === 0 ? (
              <p className="text-slate-500">No review rounds recorded for this run.</p>
            ) : roundsWithFindings.length === 0 ? (
              <p className="text-slate-500">
                The reviewer raised nothing across {meta.reviewRounds.length} round
                {meta.reviewRounds.length === 1 ? '' : 's'}.
              </p>
            ) : (
              <div className="space-y-2">
                {roundsWithFindings.map((round: any) => (
                  <div key={round.round} data-testid="finalize-summary-review-round">
                    <div className="mb-1 text-[11px] font-medium text-slate-400">
                      Round {round.round} ·{' '}
                      {round.verdict === 'approved' ? 'approved' : 'changes requested'}
                    </div>
                    <ul className="space-y-1">
                      {round.findings.map((finding: any, i: number) => (
                        <li
                          key={`${finding.filePath}-${i}`}
                          data-testid="finalize-summary-finding"
                          className="rounded bg-slate-950/40 px-2 py-1"
                        >
                          <div className="font-mono text-[10px] text-slate-500">
                            {finding.filePath} {formatAnchor(finding)}
                          </div>
                          <div className="whitespace-pre-wrap break-words">{finding.body}</div>
                        </li>
                      ))}
                      {round.truncatedFindings > 0 ? (
                        <li className="text-slate-500">
                          …and {round.truncatedFindings} more finding
                          {round.truncatedFindings === 1 ? '' : 's'}
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            testId="finalize-summary-manual-testing"
            icon={ClipboardCheck}
            title="Manual testing to perform"
            count={meta.manualTesting.length || null}
          >
            {meta.manualTesting.length ? (
              <ul className="space-y-1">
                {meta.manualTesting.map((step: string, i: number) => (
                  <li
                    key={`${i}-${step}`}
                    data-testid="finalize-summary-manual-step"
                    className="flex gap-2"
                  >
                    <FileDiff size={12} className="mt-0.5 shrink-0 text-slate-600" />
                    <span className="break-words">{step}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500">
                No manual testing steps were generated for this change.
              </p>
            )}
          </Section>
        </div>

        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
