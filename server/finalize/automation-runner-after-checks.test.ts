import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinalizeRunRow, PullRequestRow, RouteDeps, SessionRow } from '../types.js';

// Regression for the "Auto Merge didn't merge" bug: native PRs have no
// `gh pr merge --auto`, so a one-shot auto-merge that raced an in-flight
// required check (409 "checks are still running") left the PR stranded open
// forever. `maybeAutoMergeAfterChecks` is the recovery — fired when a head's
// checks pass, it re-attempts the merge, but ONLY for a PR whose originating
// session is at automation level `merge`.
//
// These tests use the REAL automation predicates (no ./automation.js mock) so
// the level gate is exercised end-to-end, and only stub the heavy sibling
// modules that module-load pulls in but this path never calls.

vi.mock('./trigger-run.js', () => ({ startFinalizeRunBackground: vi.fn() }));
vi.mock('./push-run.js', () => ({ runFinalizePush: vi.fn() }));
vi.mock('./ensure-kanban-card.js', () => ({ ensureKanbanCardForSession: vi.fn() }));

import { maybeAutoMergeAfterChecks, setFinalizeAutomationRouteDeps } from './automation-runner.js';

const PROJECT = { id: 'p1', gitHost: 'agenthub' } as const;

function makeSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    agent_id: 'a1',
    worktree_path: '/wt',
    finalize_automation: 'merge',
    ...overrides,
  } as unknown as SessionRow;
}

function wire(opts: {
  pr?: Partial<PullRequestRow> | undefined;
  pushRun?: Partial<FinalizeRunRow> | undefined;
  session?: SessionRow | undefined;
  merge?: ReturnType<typeof vi.fn>;
}): { merge: ReturnType<typeof vi.fn> } {
  const merge =
    opts.merge ?? vi.fn(async () => ({ ok: true as const, mergedSha: 'deadbeefdeadbeef0000' }));
  setFinalizeAutomationRouteDeps({
    stmts: {
      getOpenPullRequestByHeadBranch: { get: () => opts.pr },
      getFinalizeRunByPrUrl: { get: () => opts.pushRun },
      getSession: { get: () => opts.session },
    },
    nativePr: { merge },
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps);
  return { merge };
}

describe('maybeAutoMergeAfterChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges the PR when the originating session is at Auto Merge level', async () => {
    const { merge } = wire({
      pr: { number: 4 },
      pushRun: { session_id: 's1' },
      session: makeSession({ finalize_automation: 'merge' }),
    });
    await maybeAutoMergeAfterChecks({ project: PROJECT as never, branch: 'feat/x' });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, mergeMethod: 'squash', actor: 'finalize-automation' }),
    );
  });

  it('does NOT merge when the originating session is below Auto Merge level (push)', async () => {
    const { merge } = wire({
      pr: { number: 4 },
      pushRun: { session_id: 's1' },
      session: makeSession({ finalize_automation: 'push' }),
    });
    await maybeAutoMergeAfterChecks({ project: PROJECT as never, branch: 'feat/x' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('does nothing when no open PR backs the branch', async () => {
    const { merge } = wire({ pr: undefined });
    await maybeAutoMergeAfterChecks({ project: PROJECT as never, branch: 'feat/x' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('does nothing when the PR has no originating push run (cannot resolve a level)', async () => {
    const { merge } = wire({ pr: { number: 4 }, pushRun: undefined });
    await maybeAutoMergeAfterChecks({ project: PROJECT as never, branch: 'feat/x' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('does nothing for a non-agenthub project', async () => {
    const { merge } = wire({
      pr: { number: 4 },
      pushRun: { session_id: 's1' },
      session: makeSession({ finalize_automation: 'merge' }),
    });
    await maybeAutoMergeAfterChecks({
      project: { id: 'p1', gitHost: 'github' } as never,
      branch: 'feat/x',
    });
    expect(merge).not.toHaveBeenCalled();
  });

  // Contract for the call site: the function REJECTS on an internal failure
  // (e.g. a malformed prepared statement) rather than swallowing it. The hook
  // is dispatched detached, so the index.ts wiring MUST attach a `.catch(...)`
  // — without it this becomes an unhandled rejection.
  it('rejects on an internal failure so the detached caller can catch it', async () => {
    setFinalizeAutomationRouteDeps({
      stmts: {
        getOpenPullRequestByHeadBranch: {
          get: () => {
            throw new Error('bad stmt');
          },
        },
      },
      nativePr: { merge: vi.fn() },
      broadcast: vi.fn(),
      config: {},
    } as unknown as RouteDeps);
    await expect(
      maybeAutoMergeAfterChecks({ project: PROJECT as never, branch: 'feat/x' }),
    ).rejects.toThrow('bad stmt');
  });
});
