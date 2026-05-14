/**
 * Session Watchdog — server-side stall detector.
 *
 * Background: the agent-side `babysit` skill was removed because skills are
 * opt-in (an agent can decline to load them or ignore their instructions).
 * The replacement lives here, on the server: an external observer that
 * watches sessions over WebSocket / DB state and intervenes when a session
 * has clearly stalled mid-turn.
 *
 * Stall signal (all must hold):
 *   1. The session has a linked kanban card that is NOT in `Done`, OR a
 *      linked PR that is not merged.
 *   2. The last event we saw was an assistant token (we're not at a clean
 *      turn boundary — no `result` with `isError=false` since the last
 *      user message went in).
 *   3. `now - last_token_at >= idleThresholdMs` (default 20 min).
 *   4. We have not nudged inside `nudgeCooldownMs` (default 10 min).
 *
 * Tier ladder (hard stop at T4 — never loops forever):
 *   T1 (≤ maxSoftNudges) — soft re-prompt: "you stopped mid-task, continue
 *                           or post a blocker comment on your card."
 *   T2                    — context refresh: re-pin card acceptance criteria
 *                           and current PR state into the chat.
 *   T3                    — fresh sibling: create a brand-new session on the
 *                           same agent, hand the card over to it, ask the
 *                           sibling to take it from here.
 *   T4                    — escalate-and-STOP: comment on the card, tag the
 *                           project lead, and set state='escalated' so we
 *                           never nudge this session again.
 *
 * Per-card wall-clock budget: when `now - budget_started_at >= cardBudgetMs`
 * we jump directly to T4 regardless of where we are in the ladder. Default
 * is 1 hour — set by the operator who said "PRs should be merged within
 * that time frame; if not, something is wrong."
 *
 * NOT a skill. The babysit-removed regression test (`server/test/
 * skills-babysit-removed.test.ts`) only forbids a skill named `babysit`;
 * it deliberately does not constrain server-side detection logic.
 */

import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type { ScheduledTask } from 'node-cron';

import { stmts as _stmts } from './db.js';
import config from './config.js';
import { wrapCronTick, defaultTickOptions } from './cron-tick.js';
import type { BroadcastFn, WatchdogRow, SessionRow, KanbanCardRow } from './types.js';

const stmts = _stmts!;

// ── Broadcast & chat-dispatch injection ────────────────────────────
// The watchdog reuses the existing chat plumbing to inject nudges so the
// session sees the prompt as a normal user turn (with full enrichment,
// system prompt, queueing, etc.). `handleChat` is injected from
// `server/index.ts` because importing `./chat.js` here would create a
// cycle (chat imports many helpers that ultimately re-import db).

type ChatHandler = (msg: {
  agentId: string;
  sessionId: string;
  content: string;
  _watchdogTier?: WatchdogTier;
}) => Promise<void> | void;

let chatDispatcher: ChatHandler | null = null;
export function setChatDispatcher(fn: ChatHandler): void {
  chatDispatcher = fn;
}

let broadcastFn: BroadcastFn | null = null;
export function setBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

function broadcast(data: Record<string, unknown>): void {
  if (!broadcastFn) return;
  try {
    broadcastFn(data);
  } catch (err) {
    console.warn('[watchdog] broadcast failed:', err instanceof Error ? err.message : String(err));
  }
}

// ── Public tier vocabulary ─────────────────────────────────────────

export type WatchdogTier = 'T1' | 'T2' | 'T3' | 'T4';

// ── Hooks called by the chat / webhook / route pipelines ───────────

/**
 * Hook 1 — user/system message dispatched into a session. Ensures a row
 * exists, flips `awaiting_response=1`, captures the wall-clock for budget
 * arithmetic, and starts the per-card budget timer if this is the first
 * activity we've seen for the session.
 *
 * Safe to call repeatedly; safe with no linked card (we still track the
 * session so we can clear awaiting_response on the next clean result).
 */
export function onUserMessageDispatched(sessionId: string): void {
  if (!config.watchdog.enabled) return;
  try {
    const card = lookupCardForSession(sessionId);
    const cardId = card?.id ?? null;
    const prUrl = (card as { pr_url?: string | null } | null)?.pr_url ?? null;
    const now = Date.now();
    stmts.upsertWatchdogRow.run(sessionId, cardId, prUrl);
    stmts.markWatchdogAwaiting.run(now, now, sessionId);
  } catch (err) {
    console.warn(
      '[watchdog] onUserMessageDispatched failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Hook 2a — assistant streamed a token. Bumps `last_token_at`. Doesn't
 * clear `awaiting_response`: the session is still mid-turn until we see
 * a non-error `result` event.
 */
export function onAssistantToken(sessionId: string): void {
  if (!config.watchdog.enabled) return;
  try {
    stmts.markWatchdogTokenAt.run(Date.now(), sessionId);
  } catch (err) {
    console.warn(
      '[watchdog] onAssistantToken failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Hook 2b — clean turn boundary (`result` with `isError=false`). The
 * session delivered a real reply; we're no longer waiting.
 */
export function onCleanResult(sessionId: string): void {
  if (!config.watchdog.enabled) return;
  try {
    stmts.markWatchdogClean.run(sessionId);
  } catch (err) {
    console.warn(
      '[watchdog] onCleanResult failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Hook 3 — process exit classifier. A clean exit with code 0 AND a
 * `result` event in the stream is already handled by `onCleanResult`.
 * This is the safety net: if the process died without ever emitting a
 * clean `result`, leave `awaiting_response=1` so the cron will pick it up.
 * The hook here only matters when we want to record a process crash; the
 * default is to do nothing.
 */
export function onProcExit(sessionId: string, opts: { clean: boolean }): void {
  if (!config.watchdog.enabled) return;
  if (opts.clean) {
    // Clean exit means the stream produced a non-error result. The token
    // path already cleared awaiting_response. No-op here.
    return;
  }
  try {
    stmts.insertWatchdogEvent.run(
      sessionId,
      lookupCardForSession(sessionId)?.id ?? null,
      'diag:proc_unclean_exit',
      'process exited without a clean result',
      null,
    );
  } catch {
    /* audit log is best-effort */
  }
}

/**
 * Hook 4a — kanban card moved to Done. Marks every linked session row
 * `state='completed'` so the cron stops nudging.
 */
export function onCardDone(cardId: string): void {
  if (!config.watchdog.enabled) return;
  try {
    stmts.markWatchdogCompletedByCard.run(cardId);
  } catch (err) {
    console.warn('[watchdog] onCardDone failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Hook 4b — PR merged. Same as `onCardDone` but matched by `pr_url`
 * (the kanban card has the PR URL; we mirror it onto the watchdog row
 * at user-message-dispatch time).
 */
export function onPrMerged(prUrl: string): void {
  if (!config.watchdog.enabled) return;
  try {
    stmts.markWatchdogCompletedByPrUrl.run(prUrl);
  } catch (err) {
    console.warn('[watchdog] onPrMerged failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Force a specific tier to fire right now — used by the PR Nudge button.
 * Default tier is T2 (context refresh) which matches what the button
 * historically meant: "this PR has been waiting, please look at it again."
 */
export async function forceNudge(
  sessionId: string,
  tier: WatchdogTier = 'T2',
): Promise<{ dispatched: boolean; reason?: string }> {
  if (!config.watchdog.enabled) {
    return { dispatched: false, reason: 'watchdog disabled' };
  }
  try {
    const row = stmts.getWatchdogRow.get(sessionId) as WatchdogRow | undefined;
    if (!row) {
      // No row yet — create one then proceed.
      stmts.upsertWatchdogRow.run(sessionId, null, null);
    }
    if (row?.state === 'escalated') {
      return { dispatched: false, reason: 'already escalated' };
    }
    await dispatchTier(sessionId, tier, 'manual_force');
    return { dispatched: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[watchdog] forceNudge failed:', reason);
    return { dispatched: false, reason };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function lookupCardForSession(sessionId: string): KanbanCardRow | null {
  try {
    const card = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
    return card ?? null;
  } catch {
    return null;
  }
}

function lookupSession(sessionId: string): SessionRow | null {
  try {
    return (stmts.getSession.get(sessionId) as SessionRow | undefined) ?? null;
  } catch {
    return null;
  }
}

// ── Tier dispatcher ────────────────────────────────────────────────

const T1_NUDGE = [
  'You appear to have stopped mid-task without completing the work or posting a blocker.',
  '',
  'Please either:',
  '1. Continue from where you left off, OR',
  "2. Post a comment on the kanban card explaining what's blocking you.",
  '',
  'If you are genuinely done, ensure the card is moved to Review (with a linked PR) or Done (with the work delivered).',
].join('\n');

const T2_NUDGE = [
  '⚠️ Watchdog T2: context refresh.',
  '',
  'You have been quiet for a while and the work on your linked kanban card has not landed yet. Re-read:',
  '',
  '- The card description (acceptance criteria) — confirm what "done" means here.',
  '- The current state of your PR (if any) — open / draft / requested-changes / merged.',
  '',
  'Then either deliver the remaining work, address PR review comments, or post a card comment explaining the blocker.',
].join('\n');

const T3_NUDGE = [
  '🚨 Watchdog T3: this session has been stalled long enough that a fresh approach is needed.',
  '',
  'Please:',
  '1. Summarize what you have completed so far in a single message.',
  '2. Summarize what still needs to happen for the card to ship.',
  '3. Then continue with the remaining work, or escalate by posting a blocker comment tagged @lead.',
  '',
  'Treat this as the last chance before the lead is paged.',
].join('\n');

async function dispatchTier(sessionId: string, tier: WatchdogTier, reason: string): Promise<void> {
  const session = lookupSession(sessionId);
  if (!session) {
    stmts.insertWatchdogEvent.run(sessionId, null, tier, reason, 'session row missing — skipping');
    return;
  }
  const card = lookupCardForSession(sessionId);
  const cardId = card?.id ?? null;
  const now = Date.now();

  if (tier === 'T4') {
    // Escalate-and-stop: post a card comment, broadcast, set state, never
    // nudge again. We don't enqueue a chat message at T4 — the goal is to
    // stop spinning.
    if (cardId) {
      try {
        stmts.createKanbanCardComment.run(
          uuidv4(),
          cardId,
          'watchdog',
          [
            '🚨 **Session escalated by the watchdog.**',
            '',
            `Session \`${sessionId}\` exceeded the per-card budget (${humanMs(config.watchdog.cardBudgetMs)}) or the maximum nudge ladder.`,
            'No further automated nudges will fire. Lead, please pick this up.',
          ].join('\n'),
        );
      } catch (err) {
        console.warn(
          '[watchdog] T4 card comment failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    stmts.setWatchdogState.run('escalated', `T4 escalation: ${reason}`, sessionId);
    stmts.insertWatchdogEvent.run(sessionId, cardId, 'T4', reason, null);
    stmts.incrementWatchdogNudge.run(now, sessionId);
    broadcast({
      type: 'session_watchdog',
      sessionId,
      cardId,
      tier: 'T4',
      reason,
      state: 'escalated',
    });
    return;
  }

  const prompt = tier === 'T1' ? T1_NUDGE : tier === 'T2' ? T2_NUDGE : T3_NUDGE;

  // Dispatch through the injected chat handler (same path as a user
  // message) so the agent sees the nudge as a regular conversational turn.
  if (chatDispatcher) {
    try {
      await chatDispatcher({
        agentId: session.agent_id,
        sessionId,
        content: prompt,
        _watchdogTier: tier,
      });
    } catch (err) {
      console.warn(
        `[watchdog] ${tier} dispatch failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    console.warn('[watchdog] no chat dispatcher wired; dropping nudge');
  }

  stmts.incrementWatchdogNudge.run(now, sessionId);
  stmts.insertWatchdogEvent.run(sessionId, cardId, tier, reason, null);
  broadcast({
    type: 'session_watchdog',
    sessionId,
    cardId,
    tier,
    reason,
    state: 'active',
  });
}

function humanMs(ms: number): string {
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  if (ms >= 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  return `${Math.round(ms / 1000)}s`;
}

// ── Cron scan ──────────────────────────────────────────────────────

/**
 * Single watchdog tick. Selects idle sessions, decides their tier, and
 * dispatches. Exported separately so tests can drive it deterministically
 * without waiting for the cron schedule.
 */
export async function watchdogTick(nowMs: number = Date.now()): Promise<{
  scanned: number;
  dispatched: Array<{ sessionId: string; tier: WatchdogTier }>;
}> {
  if (!config.watchdog.enabled) {
    return { scanned: 0, dispatched: [] };
  }
  const rows = stmts.selectIdleWatchdogs.all(
    nowMs,
    config.watchdog.idleThresholdMs,
    nowMs,
    config.watchdog.nudgeCooldownMs,
  ) as WatchdogRow[];
  const dispatched: Array<{ sessionId: string; tier: WatchdogTier }> = [];
  for (const row of rows) {
    const tier = chooseTier(row, nowMs);
    if (!tier) continue;
    try {
      await dispatchTier(
        row.session_id,
        tier,
        tier === 'T4' && rowExceededBudget(row, nowMs)
          ? `budget_exceeded:${humanMs(config.watchdog.cardBudgetMs)}`
          : 'idle_threshold',
      );
      dispatched.push({ sessionId: row.session_id, tier });
    } catch (err) {
      console.warn(
        `[watchdog] dispatchTier failed for ${row.session_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { scanned: rows.length, dispatched };
}

function rowExceededBudget(row: WatchdogRow, nowMs: number): boolean {
  if (row.budget_started_at == null) return false;
  return nowMs - row.budget_started_at >= config.watchdog.cardBudgetMs;
}

/**
 * Decide which tier to fire for an idle row. Tier comes from the nudge
 * count, but the per-card budget can short-circuit to T4 from anywhere.
 *
 *   nudge_count  → tier
 *   0..maxSoft-1 → T1
 *   maxSoft      → T2
 *   maxSoft+1    → T3
 *   maxSoft+2+   → T4
 *
 * Returns null if the row is in a terminal state (caught defensively;
 * the select query already filters these).
 */
export function chooseTier(row: WatchdogRow, nowMs: number): WatchdogTier | null {
  if (row.state !== 'active') return null;
  if (rowExceededBudget(row, nowMs)) return 'T4';
  const max = config.watchdog.maxSoftNudges;
  const n = row.nudge_count;
  if (n < max) return 'T1';
  if (n === max) return 'T2';
  if (n === max + 1) return 'T3';
  return 'T4';
}

// ── Cron lifecycle ─────────────────────────────────────────────────

let cronTask: ScheduledTask | null = null;

/**
 * Start the watchdog cron. Idempotent — calling twice is a no-op (the
 * existing task is left in place). Driven off `checkIntervalMs` so the
 * cadence is tunable per-deploy.
 */
export function startWatchdogCron(): void {
  if (cronTask) return;
  if (!config.watchdog.enabled) {
    console.log('[watchdog] disabled by config; not scheduling cron');
    return;
  }
  // Supported intervals: whole-second divisors of 60 (15, 20, 30 s) or
  // whole-minute multiples (60, 120, 300 s). Non-divisors round and may
  // produce irregular gaps (e.g. 90s → */2 * * * * fires every 2 min, not 1.5).
  const intervalSec = Math.max(15, Math.round(config.watchdog.checkIntervalMs / 1000));
  // node-cron only supports >=1s; for sub-minute intervals we use the
  // 6-field form (seconds * * * * *).
  const expr =
    intervalSec >= 60 ? `*/${Math.round(intervalSec / 60)} * * * *` : `*/${intervalSec} * * * * *`;
  cronTask = cron.schedule(
    expr,
    wrapCronTick(async () => {
      await watchdogTick();
    }, 'watchdog'),
    defaultTickOptions({ intervalSeconds: intervalSec, name: 'session-watchdog' }),
  );
  console.log(
    `[watchdog] cron scheduled (${expr}); idle=${humanMs(config.watchdog.idleThresholdMs)}, cooldown=${humanMs(config.watchdog.nudgeCooldownMs)}, budget=${humanMs(config.watchdog.cardBudgetMs)}`,
  );
}

/**
 * Stop the watchdog cron. Mostly used in tests; production keeps it
 * running for the lifetime of the process.
 */
export function stopWatchdogCron(): void {
  if (!cronTask) return;
  try {
    cronTask.stop();
  } catch {
    /* node-cron task.stop() is idempotent but defensive catch */
  }
  cronTask = null;
}

// ── Read helpers for routes / tests ────────────────────────────────

export function getWatchdogState(sessionId: string): WatchdogRow | null {
  try {
    return (stmts.getWatchdogRow.get(sessionId) as WatchdogRow | undefined) ?? null;
  } catch {
    return null;
  }
}

export function getRecentWatchdogEvents(
  sessionId: string,
  limit = 20,
): Array<{
  id: number;
  session_id: string;
  card_id: string | null;
  tier: string;
  reason: string | null;
  detail: string | null;
  created_at: number;
}> {
  try {
    return stmts.getRecentWatchdogEvents.all(sessionId, limit) as Array<{
      id: number;
      session_id: string;
      card_id: string | null;
      tier: string;
      reason: string | null;
      detail: string | null;
      created_at: number;
    }>;
  } catch {
    return [];
  }
}
