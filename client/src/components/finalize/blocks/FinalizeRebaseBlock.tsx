import { GitMerge, CheckCircle2, XCircle } from 'lucide-react';
import { parseFinalizeRebaseMetadata } from '../../../utils/finalizeTimeline';
import { shortSha } from '../../../utils/prMessage';
import { relativeTime } from '../../../utils/time';

export default function FinalizeRebaseBlock({ message }: any) {
  const meta = parseFinalizeRebaseMetadata(message.metadata);
  if (!meta) return null;

  const roundLabel = meta.round > 0 ? `Rebase · round ${meta.round}` : 'Rebase';
  const Icon = meta.ok ? CheckCircle2 : XCircle;
  const tone = meta.ok ? 'text-emerald-300' : 'text-red-300';
  const border = meta.ok
    ? 'border-emerald-700/40 bg-emerald-950/20'
    : 'border-red-700/40 bg-red-950/20';

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-rebase-block">
      <div className={`max-w-[95%] sm:max-w-[80%] w-full border rounded-xl px-4 py-3 ${border}`}>
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-slate-400 shrink-0" />
          <div className="min-w-0">
            <p className={`text-sm font-medium ${tone}`}>
              <Icon className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
              {roundLabel} — {meta.ok ? 'completed' : 'failed'}
              {meta.conflict ? ' (conflicts resolved)' : ''}
            </p>
            {meta.headSha ? (
              <p className="text-xs text-slate-400 mt-0.5">
                HEAD{' '}
                <code className="text-[10px] bg-gray-900/60 px-1 rounded">
                  {shortSha(meta.headSha)}
                </code>
              </p>
            ) : null}
            {!meta.ok && meta.detail ? (
              <p className="text-xs text-red-200/80 mt-0.5">{meta.detail}</p>
            ) : null}
          </div>
        </div>
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
