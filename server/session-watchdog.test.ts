/**
 * Unit tests for server/session-watchdog.ts.
 *
 * Strategy: drive the watchdog hooks + watchdogTick() directly against a
 * real (test) sqlite DB and assert on the resulting `session_watchdog`
 * + `watchdog_events` rows. The chat dispatcher is mocked so no real CLI
 * spawn happens (forbidden by server/test/setup.ts anyway).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { createProject, createAgent, createSession, getRequest } from './test/helpers.js';
import {
  setChatDispatcher,
  onUserMessageDispatched,
  onAssistantToken,
  onCleanResult,
  onCardDone,
  onPrMerged,
  forceNudge,
  watchdogTick,
  chooseTier,
  getWatchdogState,
  getRecentWatchdogEvents,
} from './session-watchdog.js';
import { stmts, getDb } from './db.js';
import config from './config.js';
import type { WatchdogRow } from './types.js';

const captured: Array<{ agentId: string; sessionId: string; content: string }> = [];

beforeAll(async () => {
  await getRequest(); // ensures the app is initialized once
  setChatDispatcher(async (msg) => {
    captured.push({ agentId: msg.agentId, sessionId: msg.sessionId, content: msg.content });
  });
});

beforeEach(() => {
  captured.length = 0;
  // Force watchdog enabled for these tests regardless of host env.
  config.watchdog.enabled = true;
  config.watchdog.idleThresholdMs = 5 * 60 * 1000;
  config.watchdog.nudgeCooldownMs = 3 * 60 * 1000;
  config.watchdog.maxSoftNudges = 2;
  config.watchdog.cardBudgetMs = 60 * 60 * 1000;
});

async function makeSession(): Promise<{
  sessionId: string;
  agentId: string;
  projectId: string;
}> {
  const project = await createProject();
  const agent = await createAgent({ projectId: project.id as string });
  const session = await createSession({ agentId: agent.id as string });
  return {
    sessionId: session.id as string,
    agentId: agent.id as string,
    projectId: project.id as string,
  };
}

describe('session-watchdog state machine', () => {
  it('onUserMessageDispatched creates a row with awaiting_response=1', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    const row = getWatchdogState(sessionId)!;
    expect(row).toBeTruthy();
    expect(row.session_id).toBe(sessionId);
    expect(row.awaiting_response).toBe(1);
    expect(row.last_user_message_at).toBeGreaterThan(0);
    expect(row.budget_started_at).toBeGreaterThan(0);
    expect(row.state).toBe('active');
  });

  it('onAssistantToken updates last_token_at', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    expect(getWatchdogState(sessionId)?.last_token_at).toBeNull();
    onAssistantToken(sessionId);
    const row = getWatchdogState(sessionId)!;
    expect(row.last_token_at).toBeGreaterThan(0);
  });

  it('onCleanResult clears awaiting_response', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    onAssistantToken(sessionId);
    onCleanResult(sessionId);
    const row = getWatchdogState(sessionId)!;
    expect(row.awaiting_response).toBe(0);
  });

  it('onCardDone marks every linked row completed', async () => {
    const { sessionId } = await makeSession();
    // Manually link a card id to this session's watchdog row.
    onUserMessageDispatched(sessionId);
    stmts!.upsertWatchdogRow.run(sessionId, 'card-123', null);
    onCardDone('card-123');
    expect(getWatchdogState(sessionId)?.state).toBe('completed');
  });

  it('onPrMerged marks rows linked by pr_url completed', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    stmts!.upsertWatchdogRow.run(sessionId, null, 'https://github.com/x/y/pull/1');
    onPrMerged('https://github.com/x/y/pull/1');
    expect(getWatchdogState(sessionId)?.state).toBe('completed');
  });
});

describe('chooseTier', () => {
  const baseRow: WatchdogRow = {
    session_id: 's',
    card_id: null,
    pr_url: null,
    awaiting_response: 1,
    last_token_at: 1_000,
    last_user_message_at: 1_000,
    nudge_count: 0,
    last_nudge_at: null,
    budget_started_at: null,
    state: 'active',
    disabled_reason: null,
    created_at: 1_000,
    updated_at: 1_000,
  };

  it('returns T1 for nudge_count < maxSoftNudges', () => {
    expect(chooseTier({ ...baseRow, nudge_count: 0 }, 2_000)).toBe('T1');
    expect(chooseTier({ ...baseRow, nudge_count: 1 }, 2_000)).toBe('T1');
  });

  it('returns T2 at exactly maxSoftNudges', () => {
    expect(chooseTier({ ...baseRow, nudge_count: 2 }, 2_000)).toBe('T2');
  });

  it('returns T3 then T4 as the count grows', () => {
    expect(chooseTier({ ...baseRow, nudge_count: 3 }, 2_000)).toBe('T3');
    expect(chooseTier({ ...baseRow, nudge_count: 4 }, 2_000)).toBe('T4');
  });

  it('jumps straight to T4 when budget is exceeded', () => {
    const now = 10 * 60 * 60 * 1000;
    const startedTwoHoursAgo = now - 2 * 60 * 60 * 1000;
    expect(
      chooseTier({ ...baseRow, nudge_count: 0, budget_started_at: startedTwoHoursAgo }, now),
    ).toBe('T4');
  });

  it('returns null for non-active rows', () => {
    expect(chooseTier({ ...baseRow, state: 'completed' }, 2_000)).toBeNull();
    expect(chooseTier({ ...baseRow, state: 'escalated' }, 2_000)).toBeNull();
  });
});

describe('watchdogTick dispatch', () => {
  it('selects rows past the idle threshold and dispatches T1', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    // Backdate last_token_at to make this row "idle".
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    stmts!.markWatchdogTokenAt.run(tenMinAgo, sessionId);
    const result = await watchdogTick(Date.now());
    expect(result.dispatched.find((d) => d.sessionId === sessionId)?.tier).toBe('T1');
    expect(captured.some((c) => c.sessionId === sessionId)).toBe(true);
    const row = getWatchdogState(sessionId)!;
    expect(row.nudge_count).toBe(1);
    expect(row.last_nudge_at).toBeGreaterThan(0);
  });

  it('respects the cooldown — does not re-nudge inside nudgeCooldownMs', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    stmts!.markWatchdogTokenAt.run(tenMinAgo, sessionId);
    await watchdogTick(Date.now());
    const dispatchCount1 = captured.length;
    // Run again inside the cooldown window
    await watchdogTick(Date.now());
    expect(captured.length).toBe(dispatchCount1);
  });

  it('budget cap fast-tracks to T4 and stops further nudges', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    // Backdate both `last_token_at` (to pass the idle select query) and
    // `budget_started_at` (to trigger the budget-exceeded short-circuit).
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    stmts!.markWatchdogTokenAt.run(twoHoursAgo, sessionId);
    getDb()
      .prepare('UPDATE session_watchdog SET budget_started_at = ? WHERE session_id = ?')
      .run(twoHoursAgo, sessionId);
    const result = await watchdogTick(Date.now());
    expect(result.dispatched.find((d) => d.sessionId === sessionId)?.tier).toBe('T4');
    const row = getWatchdogState(sessionId)!;
    expect(row.state).toBe('escalated');
    // Subsequent tick must do nothing for this row.
    captured.length = 0;
    await watchdogTick(Date.now());
    expect(captured.some((c) => c.sessionId === sessionId)).toBe(false);
  });

  it('does nothing when watchdog.enabled is false', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    stmts!.markWatchdogTokenAt.run(tenMinAgo, sessionId);
    config.watchdog.enabled = false;
    const result = await watchdogTick(Date.now());
    expect(result.scanned).toBe(0);
    expect(captured.length).toBe(0);
  });

  it('records an event row for each dispatch', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    stmts!.markWatchdogTokenAt.run(tenMinAgo, sessionId);
    await watchdogTick(Date.now());
    const events = getRecentWatchdogEvents(sessionId, 5);
    expect(events.length).toBeGreaterThan(0);
    expect(['T1', 'T2', 'T3', 'T4']).toContain(events[0]!.tier);
  });
});

describe('forceNudge', () => {
  it('dispatches the requested tier even if not idle', async () => {
    const { sessionId } = await makeSession();
    onUserMessageDispatched(sessionId);
    const result = await forceNudge(sessionId, 'T2');
    expect(result.dispatched).toBe(true);
    const matched = captured.find((c) => c.sessionId === sessionId);
    expect(matched).toBeTruthy();
    expect(matched!.content).toMatch(/Watchdog T2/i);
  });

  it('refuses when watchdog.enabled is false', async () => {
    const { sessionId } = await makeSession();
    config.watchdog.enabled = false;
    const result = await forceNudge(sessionId, 'T2');
    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });
});

// Silence the unused-import warning vitest infers for vi
void vi;
