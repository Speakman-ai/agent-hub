/**
 * Parse Finalize timeline system-message metadata written by
 * `server/finalize/timeline-message.ts`.
 */

export const FINALIZE_TIMELINE_KINDS = [
  'finalize_run_started',
  'finalize_rebase_result',
  'finalize_review_round',
  'finalize_checks_round',
  'finalize_ready_to_push',
  'finalize_run_terminal',
  'finalize_fix_dispatch',
  'finalize_step_output',
];

function parseRaw(metadataString) {
  if (metadataString == null) return null;
  try {
    const parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseFinalizeTimelineKind(metadataString) {
  const parsed = parseRaw(metadataString);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  if (!FINALIZE_TIMELINE_KINDS.includes(parsed.kind)) return null;
  return parsed.kind;
}

export function parseFinalizeTimelineMetadata(metadataString) {
  const parsed = parseRaw(metadataString);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  if (!FINALIZE_TIMELINE_KINDS.includes(parsed.kind)) return null;
  return parsed;
}

export function isFinalizeStepOutputMessage(metadataString) {
  return parseFinalizeTimelineKind(metadataString) === 'finalize_step_output';
}

export function parseFinalizeReviewRoundMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_review_round') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    verdict: parsed.verdict ?? null,
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
  };
}

export function parseFinalizeChecksRoundMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_checks_round') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
  };
}

export function parseFinalizeRebaseMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_rebase_result') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    ok: Boolean(parsed.ok),
    conflict: Boolean(parsed.conflict),
    headSha: typeof parsed.headSha === 'string' ? parsed.headSha : null,
    detail: typeof parsed.detail === 'string' ? parsed.detail : null,
  };
}

export function parseFinalizeRunStartedMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_run_started') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    triggerSource: parsed.triggerSource ?? parsed.trigger_source ?? null,
    headSha: typeof parsed.headSha === 'string' ? parsed.headSha : null,
  };
}

export function parseFinalizeReadyToPushMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_ready_to_push') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    validatedHeadSha: typeof parsed.validatedHeadSha === 'string' ? parsed.validatedHeadSha : null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
  };
}

export function parseFinalizeTerminalMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_run_terminal') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    status: parsed.status ?? null,
    failureReason: parsed.failureReason ?? parsed.failure_reason ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    bypassedGates: Boolean(parsed.bypassedGates ?? parsed.bypassed_gates),
  };
}

export function parseFinalizeFixDispatchMetadata(metadataString) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_fix_dispatch') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    reviewerVerdict: parsed.reviewerVerdict ?? null,
    failedStepName: parsed.failedStepName ?? null,
    reviewerThreadCount:
      typeof parsed.reviewerThreadCount === 'number' ? parsed.reviewerThreadCount : 0,
  };
}
