/**
 * session-follow-up.ts — seed content for a follow-up session.
 *
 * A session that has pushed through Finalize is locked into ask mode
 * (`finalize/post-push-session-lock.ts`), and its worktree branch is already
 * on its way to `main`. Anything the operator discovers afterwards — a
 * migration that has to run, a command that turned out to be wrong, one more
 * code change — has nowhere to go in that session.
 *
 * Forwarding to another agent works, but it forwards the whole transcript and
 * asks the operator to pick a target. A follow-up is narrower: same agent by
 * default, and the context that matters is the end-of-run briefing (what
 * shipped, what still has to be done by hand), not 200 messages of tool calls.
 *
 * This module is pure — the route does the DB reads and passes values in — so
 * the shape of the briefing is testable without a session.
 */

import { clipUtf8StringToMaxBytes } from './utf8-clip.js';
import { parseFinalizeTimelineMetadata } from './finalize/timeline-message.js';

/** Matches the forward route's cap so both entry points reject the same input. */
export const MAX_FOLLOW_UP_PROMPT_LENGTH = 50_000;
/** Transcript tail used only when the session has no Finalize summary to quote. */
export const MAX_FOLLOW_UP_TRANSCRIPT_MESSAGES = 30;
/** Byte budget for the quoted Finalize summary. */
export const MAX_FOLLOW_UP_SUMMARY_BYTES = 20_000;
/** Byte budget for the transcript fallback. */
export const MAX_FOLLOW_UP_TRANSCRIPT_BYTES = 60_000;

export interface FinalizeSummarySnapshot {
  /** Markdown body of the summary message. */
  content: string;
  /** Follow-up steps the summary recorded, already sanitized server-side. */
  followUps: string[];
}

/** Minimal message shape this module reads. */
export interface FollowUpMessageLike {
  content?: string | null;
  metadata?: string | null;
}

/**
 * Find the most recent `finalize_run_summary` message in a session.
 *
 * Most recent rather than first: a session can finalize more than once (a fix
 * turn re-runs the whole pipeline), and only the last briefing describes the
 * code that actually shipped.
 */
export function findLatestFinalizeSummary(
  messages: readonly FollowUpMessageLike[] | null | undefined,
): FinalizeSummarySnapshot | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = messages?.[i];
    const parsed = parseFinalizeTimelineMetadata(message?.metadata);
    if (!parsed || parsed.kind !== 'finalize_run_summary') continue;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    const rawFollowUps = parsed.payload.followUps ?? parsed.payload.follow_ups;
    const followUps = Array.isArray(rawFollowUps)
      ? rawFollowUps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    return { content, followUps };
  }
  return null;
}

export interface BuildFollowUpSeedArgs {
  /** Display name of the agent that ran the original session. */
  sourceAgentName: string;
  /** Name of the original session, if it has one. */
  sourceSessionName?: string | null;
  /** Extra instructions the operator typed. */
  prompt?: string | null;
  /** End-of-run briefing from the original session, when it finalized. */
  summary?: FinalizeSummarySnapshot | null;
  /** Tail of the original conversation. Used only when `summary` is absent. */
  transcript?: string | null;
  /** PR the original session opened, when known. */
  prUrl?: string | null;
}

/**
 * Assemble the initial user message for a follow-up session.
 *
 * The branch warning is not decoration. A follow-up session gets a fresh
 * worktree cut from the base branch, so an agent that assumes it is still
 * sitting on the previous session's branch will try to amend commits that are
 * not there and produce a diff against the wrong base.
 */
export function buildFollowUpSeedMessage(args: BuildFollowUpSeedArgs): string {
  const parts: string[] = [];

  const prompt = (args.prompt ?? '').trim();
  if (prompt) {
    parts.push(prompt);
    parts.push('');
  }

  const sessionName = (args.sourceSessionName ?? '').trim();
  const label = sessionName
    ? `session with ${args.sourceAgentName} ("${sessionName}")`
    : `session with ${args.sourceAgentName}`;
  parts.push(`--- Follow-up on ${label} ---`);
  parts.push('');
  parts.push(
    'That work is already committed and finalized. This is a NEW session on a ' +
      'fresh branch cut from the base branch — the previous worktree, branch, and ' +
      'any uncommitted state are gone. Do not try to amend or continue those ' +
      'commits; make new ones here.',
  );

  const prUrl = (args.prUrl ?? '').trim();
  if (prUrl) {
    parts.push('');
    parts.push(`Pull request from that session: ${prUrl}`);
  }

  const followUps = args.summary?.followUps ?? [];
  if (followUps.length) {
    parts.push('');
    parts.push('Follow-up steps flagged at the end of that session:');
    parts.push(followUps.map((step) => `- ${step}`).join('\n'));
  }

  const summaryContent = (args.summary?.content ?? '').trim();
  const transcript = (args.transcript ?? '').trim();
  if (summaryContent) {
    parts.push('');
    parts.push('Finalize summary from that session:');
    parts.push('');
    parts.push(clipUtf8StringToMaxBytes(summaryContent, MAX_FOLLOW_UP_SUMMARY_BYTES));
  } else if (transcript) {
    // No Finalize run to quote (the session was cancelled, or shipped by hand),
    // so fall back to the tail of the conversation rather than starting the
    // follow-up with no context at all.
    parts.push('');
    parts.push('Recent conversation from that session:');
    parts.push('');
    parts.push(clipUtf8StringToMaxBytes(transcript, MAX_FOLLOW_UP_TRANSCRIPT_BYTES));
  }

  parts.push('');
  parts.push('--- End of follow-up context ---');

  return parts.join('\n');
}

/** Session name for the follow-up, capped to the same 100 chars as forward. */
export function buildFollowUpSessionName(sourceSessionName?: string | null): string {
  const base = (sourceSessionName ?? '').trim() || 'Session';
  return `[Follow-up] ${base}`.slice(0, 100);
}
