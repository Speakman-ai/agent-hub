import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFinalizeRun, isFinalizeInFlight } from '../../hooks/useFinalizeRun';
import FinalizeStepLogModal from './FinalizeStepLogModal';
import { FinalizeChecksStepList } from './blocks/FinalizeChecksStepList';

/**
 * Live CI progress while a finalize run is in the tasks phase.
 * Shown in the chat scroll between review completion and the persisted
 * finalize_checks_round timeline message (written when the phase ends).
 */
export default function FinalizeChecksLiveBlock({ sessionId, projectId }: any) {
  const { run, steps, phase, status } = useFinalizeRun({ sessionId, enabled: Boolean(sessionId) });
  const [logStep, setLogStep] = useState<any>(null);

  const inFlight = isFinalizeInFlight(status);
  const showLiveChecks =
    inFlight && status === 'running' && (phase === 'tasks' || steps.length > 0);

  if (!showLiveChecks || !run?.id) return null;

  const runningStep = steps.find((s: any) => s.state === 'running');
  const subtitle = runningStep
    ? `${runningStep.name} running…`
    : steps.length > 0
      ? 'Running checks…'
      : 'Starting checks…';

  return (
    <>
      <div className="flex justify-center mb-4" data-testid="finalize-checks-live-block">
        <div className="max-w-[95%] sm:max-w-[90%] w-full bg-slate-900/50 border border-indigo-700/40 rounded-xl px-4 py-3">
          <header className="flex items-center gap-2 mb-2">
            <Loader2 size={14} className="text-indigo-300 animate-spin shrink-0" />
            <span className="text-sm font-medium text-slate-200">Checks</span>
            <span className="text-xs text-slate-500">{subtitle}</span>
          </header>
          <FinalizeChecksStepList
            steps={steps}
            runId={run.id}
            projectId={projectId}
            onOpenLog={setLogStep}
            testIdPrefix="finalize-checks-live"
          />
        </div>
      </div>

      <FinalizeStepLogModal
        open={Boolean(logStep)}
        projectId={projectId}
        runId={run.id}
        stepIndex={logStep?.index}
        stepName={logStep?.name}
        stepState={logStep?.state}
        onClose={() => setLogStep(null)}
      />
    </>
  );
}
