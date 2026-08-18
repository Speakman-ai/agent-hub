/**
 * Session activity timeline — markers for turn change summaries, finalize
 * checks rounds, and review comments. Pure so web and mobile can share the
 * same extraction.
 *
 * Sources:
 *   - `turn_change_summary` system messages (post-turn briefing)
 *   - `finalize_checks_round` CI rounds (the "tests" the timeline tracks)
 *   - Individual threads on `finalize_review_round` (or the round itself
 *     when the reviewer posted a verdict with no findings)
 */

export const SESSION_TIMELINE_KINDS = ['change_summary', 'test_run', 'review_comment'] as const;

/**
 * Dispatched (on `window`) with `{ anchorId }` before scrolling to a timeline
 * anchor. Blocks that collapse content (e.g. review file groups) listen for it
 * and expand the group owning the anchor so the scroll target stays in the DOM.
 */
export const TIMELINE_ANCHOR_NAVIGATE_EVENT = 'timeline-anchor-navigate';

export type SessionTimelineKind = (typeof SESSION_TIMELINE_KINDS)[number];

export type SessionTimelineStatus = 'ok' | 'fail' | 'pending' | 'neutral';

export interface SessionTimelineMarker {
  id: string;
  kind: SessionTimelineKind;
  messageId: string;
  anchorId: string;
  createdAt: string | null;
  title: string;
  subtitle: string | null;
  status: SessionTimelineStatus;
}

export function changeSummaryAnchorId(messageId: string): string {
  return `change-summary:${messageId}`;
}

export function checksRoundAnchorId(messageId: string): string {
  return `test-run:checks:${messageId}`;
}

export function reviewCommentAnchorId(
  messageId: string,
  thread: { id?: unknown; thread_id?: unknown } | null | undefined,
  filePath: string,
  index: number,
): string {
  const tid = thread?.id ?? thread?.thread_id;
  if (tid != null && String(tid)) return `review-comment:${tid}`;
  return `review-comment:${messageId}:${filePath}:${index}`;
}

export function truncateTimelineText(text: string, max = 88): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1))}…`;
}

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (metadata == null) return null;
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function changeSummaryMarker(message: any): SessionTimelineMarker | null {
  const parsed = parseMetadata(message?.metadata);
  if (!parsed || parsed.kind !== 'turn_change_summary') return null;
  const messageId = String(message.id);
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const filesChanged = typeof parsed.filesChanged === 'number' ? parsed.filesChanged : null;
  return {
    id: changeSummaryAnchorId(messageId),
    kind: 'change_summary',
    messageId,
    anchorId: changeSummaryAnchorId(messageId),
    createdAt: message.created_at ?? null,
    title: summary ? truncateTimelineText(summary, 96) : 'Change summary',
    subtitle:
      filesChanged != null
        ? `${filesChanged} ${filesChanged === 1 ? 'file' : 'files'} changed`
        : null,
    status: 'neutral',
  };
}

function checksRoundMarker(message: any): SessionTimelineMarker | null {
  const parsed = parseMetadata(message?.metadata);
  if (!parsed || parsed.kind !== 'finalize_checks_round') return null;
  const messageId = String(message.id);
  const round = typeof parsed.round === 'number' ? parsed.round : 0;
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const failed = steps.find((s: any) => s?.state === 'failed');
  const passed = steps.filter((s: any) => s?.state === 'passed').length;
  const pending = steps.some((s: any) => s?.state === 'running' || s?.state === 'pending');
  let status: SessionTimelineStatus = 'neutral';
  let subtitle: string | null =
    steps.length === 0 ? 'No steps' : `${passed}/${steps.length} passed`;
  if (failed) {
    status = 'fail';
    subtitle = typeof failed.name === 'string' && failed.name ? `${failed.name} failed` : 'Failed';
  } else if (pending) {
    status = 'pending';
  } else if (steps.length > 0) {
    status = 'ok';
  }
  return {
    id: checksRoundAnchorId(messageId),
    kind: 'test_run',
    messageId,
    anchorId: checksRoundAnchorId(messageId),
    createdAt: message.created_at ?? null,
    title: round > 0 ? `Checks · round ${round}` : 'Checks',
    subtitle,
    status,
  };
}

function reviewCommentMarkers(message: any): SessionTimelineMarker[] {
  const parsed = parseMetadata(message?.metadata);
  if (!parsed || parsed.kind !== 'finalize_review_round') return [];
  const messageId = String(message.id);
  const round = typeof parsed.round === 'number' ? parsed.round : 0;
  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
  const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
  const roundLabel = round > 0 ? `Review · round ${round}` : 'Review';

  if (threads.length === 0) {
    return [
      {
        id: `review-comment:${messageId}`,
        kind: 'review_comment',
        messageId,
        anchorId: `review-comment:${messageId}`,
        createdAt: message.created_at ?? null,
        title: roundLabel,
        subtitle:
          verdict === 'approved'
            ? 'Approved'
            : verdict === 'changes_requested'
              ? 'Changes requested'
              : null,
        status:
          verdict === 'approved' ? 'ok' : verdict === 'changes_requested' ? 'fail' : 'neutral',
      },
    ];
  }

  return threads.map((thread: any, index: number) => {
    const filePath = String(thread?.file_path ?? thread?.filePath ?? '(unknown)');
    const start = thread?.line_start ?? thread?.lineStart;
    const end = thread?.line_end ?? thread?.lineEnd;
    let loc = filePath;
    if (typeof start === 'number') {
      loc =
        typeof end === 'number' && end !== start
          ? `${filePath}:${start}-${end}`
          : `${filePath}:${start}`;
    }
    const body = typeof thread?.body === 'string' ? thread.body : '';
    const anchorId = reviewCommentAnchorId(messageId, thread, filePath, index);
    return {
      id: anchorId,
      kind: 'review_comment' as const,
      messageId,
      anchorId,
      createdAt: message.created_at ?? null,
      title: body ? truncateTimelineText(body, 96) : roundLabel,
      subtitle: loc,
      status: 'neutral' as const,
    };
  });
}

/**
 * Walk loaded session messages and emit timeline markers in conversation order.
 */
export function deriveSessionTimelineMarkers(args: {
  messages?: any[] | null;
}): SessionTimelineMarker[] {
  const list = Array.isArray(args.messages) ? args.messages : [];
  const markers: SessionTimelineMarker[] = [];
  for (const message of list) {
    if (!message || message.id == null || message.role !== 'system') continue;
    const change = changeSummaryMarker(message);
    if (change) markers.push(change);
    const checks = checksRoundMarker(message);
    if (checks) markers.push(checks);
    markers.push(...reviewCommentMarkers(message));
  }
  return markers;
}
