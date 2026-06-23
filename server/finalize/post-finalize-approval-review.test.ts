import '../test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildApprovalReviewBody,
  postFinalizeApprovalReview,
} from './post-finalize-approval-review.js';
import type { FinalizeRunRow, Project, ReviewerThreadRow, SessionRow, Stmts } from '../types.js';

const PROJECT_ID = 'proj-x';
const PR_URL = `/projects/${PROJECT_ID}/pulls/42`;

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: PROJECT_ID,
    gitHost: 'agenthub',
    agents: [{ id: 'rev', name: 'Proj Reviewer', role: 'reviewer' }],
    ...over,
  } as unknown as Project;
}

function makeRun(over: Partial<FinalizeRunRow> = {}): FinalizeRunRow {
  return { id: 'run-1', reviewer_verdict: 'approved', ...over } as unknown as FinalizeRunRow;
}

const SESSION = { id: 'sess-1' } as unknown as SessionRow;

function makeStmts(opts: {
  reviewRun?: Partial<FinalizeRunRow> | undefined;
  threads?: ReviewerThreadRow[];
}): Stmts {
  return {
    getLatestReviewRunForSession: {
      get: vi.fn(() =>
        opts.reviewRun === undefined
          ? undefined
          : ({
              id: 'review-run',
              reviewer_verdict: 'approved',
              ...opts.reviewRun,
            } as FinalizeRunRow),
      ),
    },
    listReviewerThreadsForRun: { all: vi.fn(() => opts.threads ?? []) },
  } as unknown as Stmts;
}

describe('buildApprovalReviewBody', () => {
  it('includes reviewer notes when threads exist', () => {
    const body = buildApprovalReviewBody([
      {
        file_path: 'server/a.ts',
        line_start: 10,
        line_end: null,
        body: 'nit',
      } as ReviewerThreadRow,
    ]);
    expect(body).toContain('Approved by Finalize review');
    expect(body).toContain('server/a.ts:10 — nit');
  });

  it('is just the header when there are no threads', () => {
    const body = buildApprovalReviewBody([]);
    expect(body).toContain('Approved by Finalize review');
    expect(body).not.toContain('Reviewer notes');
  });
});

describe('postFinalizeApprovalReview', () => {
  let submitReview: ReturnType<typeof vi.fn>;
  let nativePr: { submitReview: typeof submitReview };

  beforeEach(() => {
    submitReview = vi.fn(() => ({ review: {} }));
    nativePr = { submitReview } as never;
  });

  it('posts an approved review on a native PR after a gate-passing push (regression)', () => {
    const stmts = makeStmts({
      reviewRun: {},
      threads: [
        { file_path: 'x.ts', line_start: 1, line_end: 2, body: 'looks good' } as ReviewerThreadRow,
      ],
    });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun(),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: false,
    });
    expect(posted).toBe(true);
    expect(submitReview).toHaveBeenCalledTimes(1);
    const arg = submitReview.mock.calls[0][0];
    expect(arg.number).toBe(42);
    expect(arg.state).toBe('approved');
    expect(arg.reviewer).toBe('Proj Reviewer');
    expect(arg.body).toContain('x.ts:1-2 — looks good');
  });

  it('does NOT post when the gate was bypassed (force / push anyway)', () => {
    const stmts = makeStmts({ reviewRun: {} });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun(),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: true,
    });
    expect(posted).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('does NOT post when the verdict is not approved', () => {
    const stmts = makeStmts({ reviewRun: { reviewer_verdict: 'changes_requested' } });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun({ reviewer_verdict: 'changes_requested' }),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: false,
    });
    expect(posted).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('does NOT post for a non-Agent-Hub-hosted project', () => {
    const stmts = makeStmts({ reviewRun: {} });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject({ gitHost: 'github' } as Partial<Project>),
      run: makeRun(),
      session: SESSION,
      prUrl: 'https://github.com/o/r/pull/42',
      bypassedGates: false,
    });
    expect(posted).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('does NOT post when the project has no reviewer agent', () => {
    const stmts = makeStmts({ reviewRun: {} });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject({
        agents: [{ id: 'dev', name: 'Dev', role: 'dev' }],
      } as Partial<Project>),
      run: makeRun(),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: false,
    });
    expect(posted).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('does NOT post when the PR URL is not a native PR URL', () => {
    const stmts = makeStmts({ reviewRun: {} });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun(),
      session: SESSION,
      prUrl: 'https://github.com/o/r/pull/42',
      bypassedGates: false,
    });
    expect(posted).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('never throws when submitReview fails (best-effort)', () => {
    submitReview.mockImplementation(() => {
      throw new Error('PR closed');
    });
    const stmts = makeStmts({ reviewRun: {} });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun(),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: false,
    });
    expect(posted).toBe(false);
  });

  it('falls back to the run verdict when no review run exists', () => {
    const stmts = makeStmts({ reviewRun: undefined });
    const posted = postFinalizeApprovalReview({
      deps: { stmts, nativePr: nativePr as never },
      project: makeProject(),
      run: makeRun({ reviewer_verdict: 'approved' }),
      session: SESSION,
      prUrl: PR_URL,
      bypassedGates: false,
    });
    expect(posted).toBe(true);
    expect(submitReview).toHaveBeenCalledTimes(1);
  });
});
