/**
 * Tests for `pr-rebase-poll.ts`. Uses an in-memory cooldown map and a
 * fake `triggerResolve` so the network / GitHub plumbing isn't involved.
 * The stale-card SQL is exercised through a stub `stmts` shape — the
 * actual SQL query is verified at integration level (db.test.ts patterns).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runPrRebasePoll,
  PR_REBASE_DISPATCH_COOLDOWN_MS,
  __test,
  type StalePrCardRow,
  type TriggerResolveResult,
} from './pr-rebase-poll.js';

const { extractPrNumber } = __test;

function makeStmts(rows: StalePrCardRow[]): {
  getStalePrCardsForRebaseCheck: { all: () => unknown[] };
} {
  return {
    getStalePrCardsForRebaseCheck: { all: () => rows },
  };
}

function makeRow(over: Partial<StalePrCardRow> = {}): StalePrCardRow {
  const base: StalePrCardRow = {
    card_id: 'card-1',
    card_title: 'Some card',
    project_id: 'proj-1',
    pr_url: 'https://github.com/o/r/pull/42',
    card_updated_at: '2026-05-19 00:00:00',
    session_agent_id: 'agent-1',
  };
  // Use Object.assign so `null` overrides aren't swallowed by `??`.
  return Object.assign(base, over);
}

describe('extractPrNumber', () => {
  it('parses the trailing /pull/<n> segment', () => {
    expect(extractPrNumber('https://github.com/o/r/pull/123')).toBe(123);
    expect(extractPrNumber('https://github.com/o/r/pull/1/files')).toBe(1);
  });
  it('returns null for non-PR URLs', () => {
    expect(extractPrNumber('https://github.com/o/r/issues/1')).toBeNull();
    expect(extractPrNumber('https://example.com')).toBeNull();
    expect(extractPrNumber('not a url')).toBeNull();
  });
});

describe('runPrRebasePoll', () => {
  it('returns 0 and calls triggerResolve once when the PR is clean', async () => {
    const triggerResolve = vi.fn(
      async (): Promise<TriggerResolveResult> => ({
        sessionId: null,
        triggered: [],
        reason: 'no-action-needed',
      }),
    );
    const cooldown = new Map<string, number>();
    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow()]),
        triggerResolve,
      },
      cooldown,
    );
    expect(dispatched).toBe(0);
    expect(triggerResolve).toHaveBeenCalledTimes(1);
    // Cooldown still set so a clean PR isn't reprobed every sweep.
    expect(cooldown.size).toBe(1);
  });

  it('counts and broadcasts dispatched rows when triggerResolve returns kinds', async () => {
    const broadcast = vi.fn();
    const triggerResolve = vi.fn(
      async (): Promise<TriggerResolveResult> => ({
        sessionId: 'sess-1',
        triggered: ['conflict'],
      }),
    );
    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow({ pr_url: 'https://github.com/o/r/pull/7' })]),
        triggerResolve,
        broadcast,
      },
      new Map(),
    );
    expect(dispatched).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pr_stale_autofix_dispatched',
        prUrl: 'https://github.com/o/r/pull/7',
        triggered: ['conflict'],
        sessionId: 'sess-1',
      }),
    );
  });

  it('respects per-PR cooldown', async () => {
    const triggerResolve = vi.fn(
      async (): Promise<TriggerResolveResult> => ({
        sessionId: 'sess-x',
        triggered: ['conflict'],
      }),
    );
    const cooldown = new Map<string, number>();
    cooldown.set('https://github.com/o/r/pull/42', Date.now());

    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow({ pr_url: 'https://github.com/o/r/pull/42' })]),
        triggerResolve,
      },
      cooldown,
    );
    expect(dispatched).toBe(0);
    expect(triggerResolve).not.toHaveBeenCalled();
  });

  it('fires again after the cooldown window expires', async () => {
    const triggerResolve = vi.fn(
      async (): Promise<TriggerResolveResult> => ({
        sessionId: 'sess-y',
        triggered: ['conflict'],
      }),
    );
    const cooldown = new Map<string, number>();
    // last dispatched 31 minutes ago — cooldown is 30
    cooldown.set(
      'https://github.com/o/r/pull/42',
      Date.now() - (PR_REBASE_DISPATCH_COOLDOWN_MS + 60_000),
    );

    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow({ pr_url: 'https://github.com/o/r/pull/42' })]),
        triggerResolve,
      },
      cooldown,
    );
    expect(dispatched).toBe(1);
    expect(triggerResolve).toHaveBeenCalledTimes(1);
  });

  it('skips rows missing a session agent id', async () => {
    const triggerResolve = vi.fn();
    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow({ session_agent_id: null })]),
        triggerResolve,
      },
      new Map(),
    );
    expect(dispatched).toBe(0);
    expect(triggerResolve).not.toHaveBeenCalled();
  });

  it('skips rows whose pr_url has no parseable PR number', async () => {
    const triggerResolve = vi.fn();
    const log = vi.fn();
    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([makeRow({ pr_url: 'https://example.com/no-pr-here' })]),
        triggerResolve,
        log,
      },
      new Map(),
    );
    expect(dispatched).toBe(0);
    expect(triggerResolve).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('logs and continues when one row throws', async () => {
    const log = vi.fn();
    const triggerResolve = vi
      .fn<(input: { prNumber: number }) => Promise<TriggerResolveResult>>()
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockResolvedValueOnce({ sessionId: 's2', triggered: ['conflict'] });

    const dispatched = await runPrRebasePoll(
      {
        stmts: makeStmts([
          makeRow({ pr_url: 'https://github.com/o/r/pull/1' }),
          makeRow({ pr_url: 'https://github.com/o/r/pull/2' }),
        ]),
        triggerResolve,
        log,
      },
      new Map(),
    );
    expect(dispatched).toBe(1);
    expect(triggerResolve).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('returns 0 cleanly when the stmt itself throws', async () => {
    const log = vi.fn();
    const triggerResolve = vi.fn();
    const dispatched = await runPrRebasePoll(
      {
        stmts: {
          getStalePrCardsForRebaseCheck: {
            all: () => {
              throw new Error('db gone');
            },
          },
        },
        triggerResolve,
        log,
      },
      new Map(),
    );
    expect(dispatched).toBe(0);
    expect(triggerResolve).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db gone'));
  });
});
