import { ChevronRight } from 'lucide-react';
import {
  formatStepDuration,
  labelForStepState,
  stepIconFor,
  stepToneFor,
} from '../../../utils/finalizeStepDisplay';

export function FinalizeChecksStepList({
  steps,
  runId,
  projectId,
  onOpenLog,
  testIdPrefix = 'finalize-checks',
}: any) {
  if (!steps?.length) {
    return <p className="text-xs text-slate-500">Starting checks…</p>;
  }

  return (
    <ol
      data-testid={`${testIdPrefix}-steps-list`}
      className="divide-y divide-slate-700/60 rounded border border-slate-700/60"
    >
      {steps.map((step: any) => (
        <StepRow
          key={step.index}
          step={step}
          runId={runId}
          projectId={projectId}
          onOpenLog={onOpenLog}
          testIdPrefix={testIdPrefix}
        />
      ))}
    </ol>
  );
}

function StepRow({ step, runId, projectId, onOpenLog, testIdPrefix }: any) {
  const tone = stepToneFor(step.state);
  const Icon = stepIconFor(step.state);
  const duration = formatStepDuration(step);
  const canOpenLog = Boolean(projectId && runId);
  const isFailed = step.state === 'failed';
  const jobLabel =
    step.jobId && step.matrixKey ? `${step.jobId} · ${step.matrixKey}` : (step.jobId ?? null);

  const openLog = () => {
    if (!canOpenLog) return;
    onOpenLog?.({ index: step.index, name: step.name, state: step.state });
  };

  return (
    <li
      data-testid={`${testIdPrefix}-step-row`}
      data-step-index={step.index}
      data-step-state={step.state}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
        canOpenLog ? 'cursor-pointer hover:bg-slate-800/40' : ''
      } ${isFailed ? 'bg-red-950/20' : ''}`}
      onClick={canOpenLog ? openLog : undefined}
      onKeyDown={
        canOpenLog
          ? (e: any) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLog();
              }
            }
          : undefined
      }
      role={canOpenLog ? 'button' : undefined}
      tabIndex={canOpenLog ? 0 : undefined}
    >
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${tone}`}>
        <Icon size={12} className={step.state === 'running' ? 'animate-spin' : ''} />
      </span>
      <span className="font-mono text-slate-200">{step.name}</span>
      {jobLabel ? (
        <span className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          {jobLabel}
        </span>
      ) : null}
      <span className="text-slate-500">{labelForStepState(step.state)}</span>
      <span className="ml-auto flex items-center gap-3">
        {duration != null ? (
          <span className="font-mono text-slate-400" data-testid={`${testIdPrefix}-step-duration`}>
            {duration}
          </span>
        ) : null}
        {step.exitCode != null ? (
          <span className="font-mono text-slate-500">exit {step.exitCode}</span>
        ) : null}
        {canOpenLog ? (
          <button
            type="button"
            onClick={(e: any) => {
              e.stopPropagation();
              openLog();
            }}
            className={`inline-flex items-center gap-1 ${
              isFailed ? 'text-red-300 hover:text-red-100' : 'text-slate-500 hover:text-slate-200'
            }`}
            data-testid={`${testIdPrefix}-step-log`}
          >
            logs
            <ChevronRight size={10} />
          </button>
        ) : null}
      </span>
    </li>
  );
}
