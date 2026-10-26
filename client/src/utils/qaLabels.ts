import type { QaPlanStatus, QaRunStatus, QaVerdict } from './api';

export const QA_STATUSES: { key: QaPlanStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

export const QA_STATUS_LABELS: Record<QaPlanStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  done: 'Done',
};

export const VERDICT_LABELS: Record<QaVerdict, string> = {
  pass: 'pass',
  fail: 'fail',
  needs_change: 'needs change',
  blocked: 'blocked',
};

export const VERDICT_CLASS: Record<QaVerdict, string> = {
  pass: 'text-emerald-400',
  fail: 'text-red-400',
  needs_change: 'text-amber-400',
  blocked: 'text-gray-400',
};

export const RUN_STATUS_CLASS: Record<QaRunStatus, string> = {
  queued: 'text-gray-400',
  running: 'text-blue-400',
  passed: 'text-emerald-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-500',
};
