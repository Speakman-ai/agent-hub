import { useMemo, useState } from 'react';
import { parseFinalizeChecksRoundMetadata } from '../../../utils/finalizeTimeline.js';
import { relativeTime } from '../../../utils/time.js';
import FinalizeStepLogModal from '../FinalizeStepLogModal.jsx';
import { FinalizeChecksStepList } from './FinalizeChecksStepList.jsx';

export default function FinalizeChecksRoundBlock({ message, projectId }) {
  const meta = useMemo(
    () => parseFinalizeChecksRoundMetadata(message.metadata),
    [message.metadata],
  );
  const [logStep, setLogStep] = useState(null);

  if (!meta) return null;

  const roundLabel = meta.round > 0 ? `Checks · round ${meta.round}` : 'Checks';
  const failed = meta.steps.find((s) => s.state === 'failed');
  const passed = meta.steps.filter((s) => s.state === 'passed').length;

  return (
    <>
      <div className="flex justify-center mb-4" data-testid="finalize-checks-round-block">
        <div className="max-w-[95%] sm:max-w-[90%] w-full bg-slate-900/50 border border-slate-700/60 rounded-xl px-4 py-3">
          <header className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm font-medium text-slate-200">{roundLabel}</span>
            <span className="text-xs text-slate-500">
              {failed
                ? `${failed.name} failed`
                : meta.steps.length === 0
                  ? 'No steps'
                  : `${passed}/${meta.steps.length} passed`}
            </span>
          </header>

          {meta.steps.length === 0 ? (
            <p className="text-xs text-slate-500">No CI steps ran on this pass.</p>
          ) : (
            <FinalizeChecksStepList
              steps={meta.steps}
              runId={meta.runId}
              projectId={projectId}
              onOpenLog={setLogStep}
            />
          )}

          {message.created_at ? (
            <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
          ) : null}
        </div>
      </div>

      <FinalizeStepLogModal
        open={Boolean(logStep)}
        projectId={projectId}
        runId={meta.runId}
        stepIndex={logStep?.index}
        stepName={logStep?.name}
        stepState={logStep?.state}
        onClose={() => setLogStep(null)}
      />
    </>
  );
}
