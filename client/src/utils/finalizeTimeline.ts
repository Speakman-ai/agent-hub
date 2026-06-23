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

function parseRaw(metadataString: any) {
  if (metadataString == null) return null;
  try {
    const parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseFinalizeTimelineKind(metadataString: any) {
  const parsed = parseRaw(metadataString);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  if (!FINALIZE_TIMELINE_KINDS.includes(parsed.kind)) return null;
  return parsed.kind;
}

export function parseFinalizeTimelineMetadata(metadataString: any) {
  const parsed = parseRaw(metadataString);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  if (!FINALIZE_TIMELINE_KINDS.includes(parsed.kind)) return null;
  return parsed;
}

export function isFinalizeStepOutputMessage(metadataString: any) {
  return parseFinalizeTimelineKind(metadataString) === 'finalize_step_output';
}

export function parseFinalizeReviewRoundMetadata(metadataString: any) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_review_round') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    verdict: parsed.verdict ?? null,
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
  };
}

export function parseFinalizeChecksRoundMetadata(metadataString: any) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_checks_round') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
  };
}

export function parseFinalizeRebaseMetadata(metadataString: any) {
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

export function parseFinalizeRunStartedMetadata(metadataString: any) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_run_started') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    triggerSource: parsed.triggerSource ?? parsed.trigger_source ?? null,
    headSha: typeof parsed.headSha === 'string' ? parsed.headSha : null,
  };
}

export function parseFinalizeReadyToPushMetadata(metadataString: any) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_ready_to_push') return null;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    validatedHeadSha: typeof parsed.validatedHeadSha === 'string' ? parsed.validatedHeadSha : null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    // 'agenthub' when the project repo is Hub-hosted; pre-feature
    // messages lack the field and default to GitHub wording.
    host: parsed.host === 'agenthub' ? 'agenthub' : 'github',
    // False for pre-feature messages — lets the block fall back to the
    // live project state instead of trusting the default.
    hostStamped: parsed.host === 'agenthub' || parsed.host === 'github',
  };
}

export function parseFinalizeTerminalMetadata(metadataString: any) {
  const parsed = parseFinalizeTimelineMetadata(metadataString);
  if (!parsed || parsed.kind !== 'finalize_run_terminal') return null;
  const rawPrUrl = parsed.prUrl ?? parsed.pr_url;
  return {
    runId: parsed.runId ?? parsed.run_id ?? null,
    status: parsed.status ?? null,
    failureReason: parsed.failureReason ?? parsed.failure_reason ?? null,
    round: typeof parsed.round === 'number' ? parsed.round : 0,
    bypassedGates: Boolean(parsed.bypassedGates ?? parsed.bypassed_gates),
    prUrl: typeof rawPrUrl === 'string' && rawPrUrl ? rawPrUrl : null,
  };
}

export function parseFinalizeFixDispatchMetadata(metadataString: any) {
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

export function parseRawReviewVerdictContent(content: any) {
  if (typeof content !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verdict = parsed.verdict;
  if (verdict !== 'approved' && verdict !== 'changes_requested') return null;
  return {
    kind: 'finalize_review_round',
    runId: null,
    round: 0,
    verdict,
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
  };
}

function reviewVerdictMetadata(parsed: any) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verdict = parsed.verdict;
  if (verdict !== 'approved' && verdict !== 'changes_requested') return null;
  return {
    kind: 'finalize_review_round',
    runId: null,
    round: 0,
    verdict,
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
  };
}

function parseReviewVerdictPayload(raw: any) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return reviewVerdictMetadata(JSON.parse(body));
  } catch {
    return null;
  }
}

function findTrailingReviewVerdictJson(content: any) {
  const trimmed = content.trimEnd();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenceMatch && fenceMatch.index != null) {
    const meta = parseReviewVerdictPayload(fenceMatch[1] ?? '');
    if (meta) return { meta, startIndex: fenceMatch.index };
  }

  for (
    let brace = trimmed.lastIndexOf('{');
    brace >= 0;
    brace = trimmed.lastIndexOf('{', brace - 1)
  ) {
    const tail = trimmed.slice(brace);
    const meta = parseReviewVerdictPayload(tail);
    if (meta) return { meta, startIndex: brace };
  }

  return null;
}

export function extractReviewVerdictContent(content: any) {
  if (typeof content !== 'string') return { prose: content, verdict: null };

  const tagMatch = content.match(
    /<agenthub:review-verdict>\s*([\s\S]*?)\s*<\/agenthub:review-verdict>/i,
  );
  if (tagMatch) {
    const verdict = parseReviewVerdictPayload(tagMatch[1] ?? '');
    if (verdict) {
      return {
        prose: content.replace(tagMatch[0], '').trim(),
        verdict,
      };
    }
  }

  const trailing = findTrailingReviewVerdictJson(content);
  if (trailing) {
    return {
      prose: content.trimEnd().slice(0, trailing.startIndex).trimEnd(),
      verdict: trailing.meta,
    };
  }

  return { prose: content, verdict: null };
}
