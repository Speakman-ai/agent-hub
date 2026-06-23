import { CheckCircle2, XCircle, Loader2, Clock, ChevronRight } from 'lucide-react';
import { formatDuration } from '../hooks/useFinalizeRun';

export function computeStepDuration(step: any) {
  if (step.startedAt == null) return null;
  const end = step.endedAt ?? (step.state === 'running' ? Date.now() : null);
  if (end == null) return null;
  return Math.max(0, Math.floor((end - step.startedAt) / 1000));
}

export function labelForStepState(state: any) {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return state;
  }
}

export function stepIconFor(state: any) {
  switch (state) {
    case 'passed':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'running':
      return Loader2;
    case 'skipped':
      return ChevronRight;
    case 'queued':
    default:
      return Clock;
  }
}

export function stepToneFor(state: any) {
  switch (state) {
    case 'passed':
      return 'bg-emerald-900/40 text-emerald-300';
    case 'failed':
      return 'bg-red-900/40 text-red-300';
    case 'running':
      return 'bg-indigo-900/40 text-indigo-300';
    case 'skipped':
      return 'bg-slate-700/60 text-slate-400';
    case 'queued':
    default:
      return 'bg-slate-700/60 text-slate-400';
  }
}

export function formatStepDuration(step: any) {
  const duration = computeStepDuration(step);
  return duration == null ? null : formatDuration(duration);
}
