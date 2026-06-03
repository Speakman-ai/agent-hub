import { useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { parseFinalizeReviewRoundMetadata } from '../../../utils/finalizeTimeline.js';
import { relativeTime } from '../../../utils/time.js';

function VerdictPill({ verdict }) {
  if (verdict === 'approved') {
    return (
      <span
        data-testid="finalize-review-verdict"
        data-verdict="approved"
        className="inline-flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
      >
        <CheckCircle2 size={12} />
        Approved
      </span>
    );
  }
  return (
    <span
      data-testid="finalize-review-verdict"
      data-verdict="changes_requested"
      className="inline-flex items-center gap-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
    >
      <AlertTriangle size={12} />
      Changes requested
    </span>
  );
}

function formatAnchor(thread) {
  const start = thread.line_start ?? thread.lineStart;
  const end = thread.line_end ?? thread.lineEnd;
  if (start == null) return 'file-level';
  if (end == null || end === start) return `L${start}`;
  return `L${start}-${end}`;
}

export default function FinalizeReviewRoundBlock({ message }) {
  const meta = useMemo(
    () => parseFinalizeReviewRoundMetadata(message.metadata),
    [message.metadata],
  );
  const [collapsedFiles, setCollapsedFiles] = useState(() => new Set());

  const grouped = useMemo(() => {
    const map = new Map();
    for (const thread of meta?.threads ?? []) {
      const filePath = thread.file_path ?? thread.filePath ?? '(unknown)';
      const list = map.get(filePath) ?? [];
      list.push(thread);
      map.set(filePath, list);
    }
    return map;
  }, [meta?.threads]);

  if (!meta) return null;

  const toggleFile = (filePath) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const roundLabel = meta.round > 0 ? `Review · round ${meta.round}` : 'Review';

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-review-round-block">
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-slate-900/50 border border-slate-700/60 rounded-xl px-4 py-3">
        <header className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-200">{roundLabel}</span>
            <span className="text-xs text-slate-500">
              {meta.threads.length} {meta.threads.length === 1 ? 'finding' : 'findings'}
            </span>
          </div>
          {meta.verdict ? <VerdictPill verdict={meta.verdict} /> : null}
        </header>

        {meta.threads.length === 0 ? (
          <p className="text-xs text-slate-500">No findings on this pass.</p>
        ) : (
          <div className="space-y-2">
            {Array.from(grouped.entries()).map(([filePath, threads]) => {
              const collapsed = collapsedFiles.has(filePath);
              return (
                <section
                  key={filePath}
                  data-testid="finalize-review-file-group"
                  data-file-path={filePath}
                  className="rounded border border-slate-700 bg-slate-800/60"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-slate-800"
                    onClick={() => toggleFile(filePath)}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? (
                      <ChevronRight size={14} className="text-slate-500" />
                    ) : (
                      <ChevronDown size={14} className="text-slate-500" />
                    )}
                    <FileText size={14} className="text-slate-500" />
                    <span className="truncate">{filePath}</span>
                    <span className="ml-auto text-[10px] text-slate-500">
                      {threads.length} {threads.length === 1 ? 'note' : 'notes'}
                    </span>
                  </button>
                  {!collapsed ? (
                    <ol className="divide-y divide-slate-700/60 border-t border-slate-700/60">
                      {threads.map((t, i) => (
                        <li
                          key={t.id ?? `${filePath}-${i}`}
                          data-testid="finalize-review-thread"
                          className="px-3 py-2 text-xs text-slate-300"
                        >
                          <div className="mb-0.5 font-mono text-[10px] text-slate-500">
                            {formatAnchor(t)}
                          </div>
                          <div className="whitespace-pre-wrap break-words">{t.body}</div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}

        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
