/**
 * turn-change-summary.ts — post-turn "what changed / test this by hand" briefing.
 *
 * The Finalize end-of-run summary answers "what did I just build and what should
 * I poke at before merging" once, at push time. Operators wanted the same two
 * sections (the prose summary and the manual-testing checklist) after an ordinary
 * session turn that left changed files, without waiting for Finalize.
 *
 * This is the lean cousin of `finalize/run-summary.ts`: it reuses the same LLM
 * call but renders only the summary + manual-testing sections (there is no
 * reviewer and no push gate for a plain turn). Best-effort by construction — the
 * change scan, the LLM call, and the message insert are each allowed to fail
 * without affecting the turn. A missing summary is a missing convenience.
 *
 * Unlike the Finalize summary (which diffs `base...HEAD`, committed work only),
 * this diffs against the base merge-base with the **working tree**, so it
 * captures the uncommitted and untracked edits a mid-session turn usually leaves.
 */

import { randomUUID } from 'crypto';
import type { BroadcastFn } from './react-loop-observability.js';
import type { AppConfig, MessageRow, Stmts } from './types.js';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';
import { computeSessionChanges, type SessionChangeFile } from './session-changes.js';
import { generateFinalizeRunSummary } from './finalize/run-summary-llm.js';

export const TURN_CHANGE_SUMMARY_KIND = 'turn_change_summary';

/** Cap the per-file stat lines fed to the model — a 600-file dump is noise. */
export const MAX_TURN_STAT_FILES = 60;

export interface TurnChangeSummaryPayload {
  /** Prose describing the change. Always non-empty when a message is written. */
  summary: string;
  /** Where {@link summary} came from — mirrors the Finalize payload field. */
  summarySource: 'llm' | 'none';
  /** What a human should verify by hand. May be empty. */
  manualTesting: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ChangedFilesStat {
  /** `git diff --stat`-shaped text for the LLM context. */
  stat: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Build a compact, `git diff --stat`-style summary of the session's changed
 * files for the LLM context, plus the numeric totals kept in the payload.
 * Pure — no git, no I/O — so the shaping rules stay unit-testable.
 */
export function buildChangedFilesStat(files: readonly SessionChangeFile[]): ChangedFilesStat {
  const list = files ?? [];
  let insertions = 0;
  let deletions = 0;
  const lines: string[] = [];
  for (const f of list) {
    insertions += Number.isFinite(f.additions) ? f.additions : 0;
    deletions += Number.isFinite(f.deletions) ? f.deletions : 0;
    if (lines.length < MAX_TURN_STAT_FILES) {
      const tags = [
        f.status !== 'modified' ? f.status : null,
        f.untracked ? 'new' : null,
        f.binary ? 'binary' : null,
      ].filter(Boolean);
      const count = f.binary ? 'bin' : `+${f.additions} -${f.deletions}`;
      const suffix = tags.length ? ` (${tags.join(', ')})` : '';
      lines.push(`${f.path} | ${count}${suffix}`);
    }
  }
  if (list.length > MAX_TURN_STAT_FILES) {
    lines.push(`…and ${list.length - MAX_TURN_STAT_FILES} more file(s)`);
  }
  const totals = `${list.length} file${list.length === 1 ? '' : 's'} changed, +${insertions}, -${deletions}`;
  const stat = list.length ? `${lines.join('\n')}\n${totals}` : '';
  return { stat, filesChanged: list.length, insertions, deletions };
}

/**
 * Markdown body stored as the message `content`.
 *
 * The web client renders the structured payload; mobile and any plain-text
 * consumer (notifications, transcript export) only ever see this string, so it
 * has to carry both sections on its own.
 */
export function renderTurnChangeSummaryMarkdown(payload: TurnChangeSummaryPayload): string {
  const out: string[] = ['## Change summary'];
  if (payload.summary) out.push(payload.summary);
  out.push('### Manual testing');
  out.push(
    payload.manualTesting.length
      ? payload.manualTesting.map((step) => `- [ ] ${step}`).join('\n')
      : 'No manual testing steps were generated for this change.',
  );
  return out.join('\n\n');
}

export interface EmitTurnChangeSummaryDeps {
  stmts: Pick<Stmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast: BroadcastFn;
  getConfig: () => Pick<AppConfig, 'openaiApiKey'>;
  log?: (msg: string) => void;
  newId?: () => string;
  /** Injected for tests — defaults to the real worktree change scan. */
  computeChanges?: typeof computeSessionChanges;
  /** Injected for tests — defaults to the real LLM call. */
  generateNarrative?: typeof generateFinalizeRunSummary;
}

export interface EmitTurnChangeSummaryArgs {
  sessionId: string | null | undefined;
  io: SessionWorktreeIo;
  /** Preferred base branch; null lets the change scan resolve the repo default. */
  baseBranch?: string | null;
  card?: { title?: string | null; description?: string | null } | null;
}

/**
 * Scan the session's changed files, ask for a summary + manual-testing checklist,
 * and write the timeline message. Returns the message id, or `null` when there
 * was nothing worth writing (no key, clean worktree, LLM produced nothing) or
 * any step failed. Never throws.
 */
export async function emitTurnChangeSummary(
  deps: EmitTurnChangeSummaryDeps,
  args: EmitTurnChangeSummaryArgs,
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  if (!args.sessionId) return null;

  try {
    const openaiApiKey = deps.getConfig().openaiApiKey ?? null;
    // The whole value here is the two LLM sections. With no key there is nothing
    // to render, so skip the change scan entirely rather than post an empty card.
    if (!openaiApiKey) return null;

    const computeChanges = deps.computeChanges ?? computeSessionChanges;
    const generateNarrative = deps.generateNarrative ?? generateFinalizeRunSummary;

    const changes = await computeChanges({ io: args.io, baseBranch: args.baseBranch ?? null });
    if (!changes.files.length) return null;

    const { stat, filesChanged, insertions, deletions } = buildChangedFilesStat(changes.files);
    if (!stat) return null;

    const narrative = await generateNarrative({
      cardTitle: args.card?.title ?? null,
      cardDescription: args.card?.description ?? null,
      commits: [],
      diffStat: stat,
      openaiApiKey,
    });

    const summary = narrative?.summary?.trim() ?? '';
    const manualTesting = narrative?.manualTesting ?? [];
    // Nothing usable came back — a blank prose block over an empty checklist is
    // worse than no card at all. Stay silent.
    if (!summary && manualTesting.length === 0) return null;

    const payload: TurnChangeSummaryPayload = {
      summary,
      summarySource: summary ? 'llm' : 'none',
      manualTesting,
      filesChanged,
      insertions,
      deletions,
    };

    return writeTurnChangeSummaryMessage(deps, {
      sessionId: args.sessionId,
      content: renderTurnChangeSummaryMarkdown(payload),
      payload,
    });
  } catch (err) {
    log(
      `[turn-change-summary] emit failed session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Insert the system message and broadcast `{ type: 'message' }`. */
function writeTurnChangeSummaryMessage(
  deps: EmitTurnChangeSummaryDeps,
  args: { sessionId: string; content: string; payload: TurnChangeSummaryPayload },
): string | null {
  const log = deps.log ?? (() => {});
  const messageId = (deps.newId ?? (() => randomUUID()))();
  const metadata = JSON.stringify({ kind: TURN_CHANGE_SUMMARY_KIND, ...args.payload });

  try {
    deps.stmts.addMessage.run(
      messageId,
      args.sessionId,
      'system',
      args.content,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    log(
      `[turn-change-summary] addMessage failed session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  try {
    deps.stmts.touchSession.run(args.sessionId);
  } catch {
    /* best-effort */
  }

  try {
    const inserted = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
    if (inserted) {
      deps.broadcast({ type: 'message', sessionId: args.sessionId, message: inserted });
    }
  } catch (err) {
    log(
      `[turn-change-summary] broadcast failed session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return messageId;
}
