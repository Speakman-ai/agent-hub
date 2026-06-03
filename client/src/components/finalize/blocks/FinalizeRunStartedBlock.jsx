import { GitMerge } from 'lucide-react';
import { parseFinalizeRunStartedMetadata } from '../../../utils/finalizeTimeline.js';
import { shortSha } from '../../../utils/prMessage.js';
import { relativeTime } from '../../../utils/time.js';

function describeTriggerSource(source) {
  switch (source) {
    case 'ui_button':
      return 'UI button';
    case 'agent_block':
      return 'agent block';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'unknown';
  }
}

export default function FinalizeRunStartedBlock({ message }) {
  const meta = parseFinalizeRunStartedMetadata(message.metadata);
  if (!meta) return null;

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-run-started-block">
      <div className="max-w-[95%] sm:max-w-[80%] w-full bg-indigo-950/30 border border-indigo-700/40 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-indigo-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-indigo-200">Finalize run started</p>
            <p className="text-xs text-indigo-200/70 mt-0.5">
              Trigger: {describeTriggerSource(meta.triggerSource)}
              {meta.headSha ? (
                <>
                  {' '}
                  ·{' '}
                  <code className="text-[10px] bg-gray-900/60 px-1 rounded">
                    {shortSha(meta.headSha)}
                  </code>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
