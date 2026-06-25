import {
  parseFinalizeChecksRoundMetadata,
  parseFinalizeTimelineMetadata,
} from './finalizeTimeline';

export const FINALIZE_CHECKS_BACKFILL_MAX_OLDER_PAGES = 3;

const CHECKS_READY_STATUSES = new Set([
  'running',
  'dispatching',
  'pushing',
  'ready_to_push',
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

export function finalizeStatusMayHaveChecks(status: any) {
  if (typeof status !== 'string' || !status) return false;
  return CHECKS_READY_STATUSES.has(status) || status.endsWith('_passed');
}

export function hasFinalizeChecksRoundMessage(messages: any) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m: any) => Boolean(parseFinalizeChecksRoundMetadata(m?.metadata)));
}

export function hasFinalizeTimelineMessage(messages: any) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m: any) => Boolean(parseFinalizeTimelineMetadata(m?.metadata)));
}

export function shouldBackfillFinalizeChecksTimeline({
  messages,
  finalizeStatus,
  hasMore,
  olderPagesLoaded = 0,
}: any) {
  if (!hasMore) return false;
  if (olderPagesLoaded >= FINALIZE_CHECKS_BACKFILL_MAX_OLDER_PAGES) return false;
  if (!finalizeStatusMayHaveChecks(finalizeStatus)) return false;
  return !hasFinalizeChecksRoundMessage(messages);
}
