import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act, cleanup } from '@testing-library/react';
import type { QaCaseWire, QaPlanDetailWire, QaRunWire } from '../utils/api';

const getQaPlan = vi.fn<(projectId: string, planId: string) => Promise<QaPlanDetailWire>>();
const mutations = {
  approveQaPlan: vi.fn(),
  revokeQaPlanApproval: vi.fn(),
  addQaCase: vi.fn(),
  updateQaCase: vi.fn(),
  deleteQaCase: vi.fn(),
  reorderQaCases: vi.fn(),
  openQaAuthoringSession: vi.fn(),
  signOffQaPlan: vi.fn(),
  startQaRun: vi.fn(),
  updateQaPlan: vi.fn(),
  getDeployEnvironments: vi.fn(),
  getProjectBranches: vi.fn(),
};
vi.mock('../utils/api', () => ({
  api: {
    getQaPlan: (p: string, id: string) => getQaPlan(p, id),
    approveQaPlan: (...a: unknown[]) => mutations.approveQaPlan(...a),
    revokeQaPlanApproval: (...a: unknown[]) => mutations.revokeQaPlanApproval(...a),
    addQaCase: (...a: unknown[]) => mutations.addQaCase(...a),
    updateQaCase: (...a: unknown[]) => mutations.updateQaCase(...a),
    deleteQaCase: (...a: unknown[]) => mutations.deleteQaCase(...a),
    reorderQaCases: (...a: unknown[]) => mutations.reorderQaCases(...a),
    openQaAuthoringSession: (...a: unknown[]) => mutations.openQaAuthoringSession(...a),
    signOffQaPlan: (...a: unknown[]) => mutations.signOffQaPlan(...a),
    startQaRun: (...a: unknown[]) => mutations.startQaRun(...a),
    updateQaPlan: (...a: unknown[]) => mutations.updateQaPlan(...a),
    getDeployEnvironments: (...a: unknown[]) => mutations.getDeployEnvironments(...a),
    getProjectBranches: (...a: unknown[]) => mutations.getProjectBranches(...a),
  },
}));

import QaPlanDetail, {
  VerdictCell,
  autoRerunSummary,
  applyCaseFieldEdit,
  caseEditExpectedBase,
  editConflictCase,
  planCaseSave,
  rebaseCaseFieldEdits,
  caseListLockReason,
  caseVerdictLabel,
  moveCaseIds,
  rerunButtonStates,
  runDuration,
} from './QaPlanDetail';

function qaCase(id: string, latestVerdict: QaCaseWire['latestVerdict'] = null): QaCaseWire {
  return {
    id,
    planId: 'p1',
    position: 0,
    title: `Case ${id}`,
    steps: 'Open the page',
    expected: 'It loads',
    version: 1,
    createdAt: '2026-10-26 00:00:00',
    updatedAt: '2026-10-26 00:00:00',
    latestVerdict,
  };
}

function run(id: string, extra: Partial<QaRunWire> = {}): QaRunWire {
  return {
    id,
    planId: 'p1',
    iteration: 1,
    scope: 'full',
    status: 'passed',
    approvalSeq: 1,
    sessionId: null,
    sessionAgentId: null,
    startedBy: 'u1',
    startedAt: '2026-10-26 10:00:00',
    finishedAt: '2026-10-26 10:03:12',
    createdAt: '2026-10-26 10:00:00',
    ...extra,
  };
}

function detail(over: Partial<QaPlanDetailWire> & { approved?: boolean } = {}): QaPlanDetailWire {
  const { approved = true, ...rest } = over;
  return {
    plan: {
      id: 'p1',
      projectId: 'proj',
      title: 'Checkout plan',
      goal: 'Buy a thing',
      targetUrl: 'https://shop.example.com/cart',
      epicId: 'e1',
      cardId: null,
      deployEnvironment: null,
      status: 'in_progress',
      approved,
      approvedAt: approved ? '2026-10-26 09:00:00' : null,
      approvedBy: approved ? 'u1' : null,
      approvalSeq: 1,
      signedOffAt: null,
      signedOffBy: null,
      autoRerun: true,
      autoRerunTrigger: 'deployment',
      autoRerunBranch: null,
      autoRerunDelayMinutes: 0,
      maxIterations: 5,
      createdBy: 'u1',
      authoringSessionId: null,
      createdAt: '2026-10-26 00:00:00',
      updatedAt: '2026-10-26 00:00:00',
    },
    links: { epic: { id: 'e1', name: 'Checkout epic' }, card: null },
    cases: [],
    runs: [],
    signOffBlocker: 'never run',
    ...rest,
  };
}

beforeEach(() => {
  getQaPlan.mockReset();
  for (const m of Object.values(mutations)) m.mockReset().mockResolvedValue({});
});

describe('caseVerdictLabel', () => {
  it('labels not-run, current, and stale verdicts', () => {
    expect(caseVerdictLabel(null)).toBe('Not run');
    expect(
      caseVerdictLabel({
        verdict: 'needs_change',
        caseVersion: 1,
        current: true,
        runId: 'r',
        iteration: 2,
      }),
    ).toBe('needs change (run 2)');
    expect(
      caseVerdictLabel({
        verdict: 'pass',
        caseVersion: 1,
        current: false,
        runId: 'r',
        iteration: 1,
      }),
    ).toBe('pass (run 1, case edited since)');
  });
});

describe('runDuration', () => {
  it('formats finished, in-flight, and unstarted runs', () => {
    expect(runDuration(run('a'))).toBe('3m 12s');
    expect(runDuration(run('b', { finishedAt: null }), new Date('2026-10-26T11:30:00Z'))).toBe(
      '1h 30m',
    );
    expect(runDuration(run('c', { startedAt: null, finishedAt: null }))).toBeNull();
  });
});

describe('VerdictCell', () => {
  it('renders each verdict with its colour and run iteration', () => {
    const cases = [
      ['pass', 'text-emerald-400', 'pass'],
      ['fail', 'text-red-400', 'fail'],
      ['needs_change', 'text-amber-400', 'needs change'],
      ['blocked', 'text-gray-400', 'blocked'],
    ] as const;
    for (const [verdict, cls, label] of cases) {
      const { unmount } = render(
        <VerdictCell
          latest={{ verdict, caseVersion: 1, current: true, runId: 'r', iteration: 3 }}
        />,
      );
      const cell = screen.getByTestId('qa-verdict');
      expect(cell.dataset.verdict).toBe(verdict);
      expect(within(cell).getByText(label).className).toContain(cls);
      expect(within(cell).getByText('run 3')).toBeTruthy();
      expect(within(cell).queryByText('stale')).toBeNull();
      unmount();
    }
  });

  it('marks a verdict from an older case version as stale and drops its colour', () => {
    render(
      <VerdictCell
        latest={{ verdict: 'fail', caseVersion: 1, current: false, runId: 'r', iteration: 1 }}
      />,
    );
    const cell = screen.getByTestId('qa-verdict');
    expect(cell.dataset.current).toBe('false');
    expect(within(cell).getByText('stale')).toBeTruthy();
    expect(within(cell).getByText('fail').className).not.toContain('text-red-400');
  });

  it('shows Not run when the case has no verdict', () => {
    render(<VerdictCell latest={null} />);
    expect(screen.getByTestId('qa-verdict').textContent).toBe('Not run');
  });
});

describe('QaPlanDetail', () => {
  it('shows target, chips, status, approval, cases with verdicts, and run history', async () => {
    const onOpenEpic = vi.fn();
    const onOpenSession = vi.fn();
    getQaPlan.mockResolvedValue(
      detail({
        cases: [
          qaCase('a', {
            verdict: 'pass',
            caseVersion: 1,
            current: true,
            runId: 'r2',
            iteration: 2,
          }),
          qaCase('b', {
            verdict: 'fail',
            caseVersion: 1,
            current: true,
            runId: 'r2',
            iteration: 2,
          }),
          qaCase('c'),
        ],
        runs: [
          run('r2', {
            iteration: 2,
            scope: 'failed_only',
            status: 'failed',
            sessionId: 's2',
            sessionAgentId: 'qa-agent',
          }),
          // An archived run session keeps its id (for screenshots) but no agent.
          run('r1', { sessionId: 's1' }),
        ],
      }),
    );
    render(
      <QaPlanDetail
        projectId="proj"
        planId="p1"
        onBack={() => {}}
        onOpenEpic={onOpenEpic}
        onOpenSession={onOpenSession}
      />,
    );

    await screen.findByText('Checkout plan');
    expect(getQaPlan).toHaveBeenCalledWith('proj', 'p1');
    const target = screen.getByTestId('qa-detail-target') as HTMLAnchorElement;
    expect(target.href).toBe('https://shop.example.com/cart');
    expect(screen.getByTestId('qa-detail-status').textContent).toBe('In progress');
    expect(screen.getByTestId('qa-detail-approval').textContent).toBe('Approved');
    expect(screen.queryByTestId('qa-detail-unapproved')).toBeNull();

    fireEvent.click(screen.getByText('Checkout epic'));
    expect(onOpenEpic).toHaveBeenCalledWith('e1');

    const verdictOf = (id: string) =>
      within(screen.getByTestId(`qa-case-row-${id}`)).getByTestId('qa-verdict');
    expect(verdictOf('a').dataset.verdict).toBe('pass');
    expect(verdictOf('b').dataset.verdict).toBe('fail');
    expect(verdictOf('c').textContent).toBe('Not run');

    const newest = screen.getByTestId('qa-run-row-r2');
    expect(within(newest).getByText('Run 2')).toBeTruthy();
    expect(within(newest).getByText('Failed only')).toBeTruthy();
    expect(within(newest).getByTestId('qa-run-status').textContent).toBe('failed');
    expect(within(newest).getByText(/3m 12s/)).toBeTruthy();
    fireEvent.click(within(newest).getByTestId('qa-run-session'));
    expect(onOpenSession).toHaveBeenCalledWith('qa-agent', 's2');
    expect(within(screen.getByTestId('qa-run-row-r1')).queryByTestId('qa-run-session')).toBeNull();

    // The newest run's results are open; older runs open on demand.
    expect(within(newest).getByTestId('qa-run-results-empty')).toBeTruthy();
    const older = screen.getByTestId('qa-run-row-r1');
    expect(within(older).queryByTestId('qa-run-results-empty')).toBeNull();
    fireEvent.click(within(older).getByTestId('qa-run-toggle'));
    expect(within(older).getByTestId('qa-run-results-empty')).toBeTruthy();
  });

  it('shows empty states for an unapproved plan with no cases and no runs', async () => {
    getQaPlan.mockResolvedValue(detail({ approved: false }));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);

    await screen.findByText('Checkout plan');
    expect(screen.getByTestId('qa-detail-approval').textContent).toBe('Not approved');
    expect(screen.getByTestId('qa-detail-unapproved')).toBeTruthy();
    expect(screen.getByTestId('qa-cases-empty').textContent).toMatch(/approve the plan/);
    expect(screen.getByTestId('qa-runs-empty').textContent).toMatch(/once the plan is approved/);
  });

  it('shows a never-run empty state for an approved plan', async () => {
    getQaPlan.mockResolvedValue(detail({ cases: [qaCase('a')] }));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);

    await screen.findByText('Checkout plan');
    expect(screen.getByTestId('qa-runs-empty').textContent).toMatch(/Start a run/);
    expect(screen.queryByTestId('qa-cases-empty')).toBeNull();
  });

  it('refreshes on a qa_update for this plan and ignores other plans', async () => {
    getQaPlan.mockResolvedValue(detail());
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
    await screen.findByText('Checkout plan');
    expect(getQaPlan).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'other' } }),
      );
    });
    expect(getQaPlan).toHaveBeenCalledTimes(1);

    getQaPlan.mockResolvedValue(detail({ cases: [qaCase('new')] }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await screen.findByTestId('qa-case-row-new');
  });

  it('shows the load error', async () => {
    getQaPlan.mockRejectedValue(new Error('QA plan not found'));
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('QA plan not found')).toBeTruthy());
  });
});

describe('case list helpers', () => {
  it('moveCaseIds swaps neighbours and refuses out-of-range moves', () => {
    expect(moveCaseIds(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveCaseIds(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveCaseIds(['a', 'b'], 0, -1)).toBeNull();
    expect(moveCaseIds(['a', 'b'], 1, 1)).toBeNull();
  });

  it('applyCaseFieldEdit captures the base on the first keystroke of each field', () => {
    const shown = { title: 'Login', steps: 'B', expected: 'Dashboard' };
    let edits = applyCaseFieldEdit({}, 'steps', 'B1', shown);
    edits = applyCaseFieldEdit(edits, 'steps', 'A', { ...shown, steps: 'B1' });
    expect(edits).toEqual({ steps: { value: 'A', base: 'B' } });
  });

  it('planCaseSave sends only typed-in fields whose text differs from their start', () => {
    expect(planCaseSave({ title: { value: ' Login ', base: 'Login' } })).toBeNull();
    // Setting a live-updated value back to its earlier text is a real edit.
    expect(planCaseSave({ steps: { value: 'A', base: 'B' } })).toEqual({ steps: 'A' });
    expect(planCaseSave({})).toBeNull();
  });

  it('builds the server precondition and reads a server conflict', () => {
    const edits = {
      title: { value: 'Sign in', base: 'Login' },
      steps: { value: 'Same', base: 'Same' },
    };
    expect(caseEditExpectedBase(edits, { title: 'Sign in' })).toEqual({ title: 'Login' });
    const saved = { title: 'Agent title', steps: 'Agent', expected: 'x' };
    // Only sent fields are rebased; a reverted field is dropped, not turned into an edit.
    expect(rebaseCaseFieldEdits(edits, saved, ['title'])).toEqual({
      title: { value: 'Sign in', base: 'Agent title' },
    });
    expect(editConflictCase({ code: 'edit_conflict', body: { case: saved } })).toEqual(saved);
    expect(editConflictCase({ code: 'run_active', body: { case: saved } })).toBeNull();
    expect(editConflictCase(new Error('boom'))).toBeNull();
  });

  it('caseListLockReason freezes done plans and plans with an active run', () => {
    expect(caseListLockReason(detail())).toBeNull();
    const done = detail();
    done.plan.status = 'done';
    expect(caseListLockReason(done)).toMatch(/Signed off/);
    expect(
      caseListLockReason(detail({ runs: [run('r', { status: 'running', iteration: 3 })] })),
    ).toBe('Run 3 is running. Cancel it to edit cases.');
  });
});

type CaseText = { title: string; steps: string; expected: string };

/**
 * Make updateQaCase behave like the server: an edit whose expectedBase no
 * longer matches the saved text (and does not already equal the new value)
 * is refused with edit_conflict and the saved text.
 */
function serverHolds(saved: CaseText) {
  const state = { ...saved };
  mutations.updateQaCase.mockImplementation(
    async (
      _p: string,
      _plan: string,
      _id: string,
      body: Partial<CaseText> & { expectedBase?: Partial<CaseText> },
    ) => {
      const { expectedBase = {}, ...fields } = body;
      const conflicts = (Object.keys(expectedBase) as Array<keyof CaseText>).filter(
        (f) => state[f] !== expectedBase[f] && state[f] !== fields[f],
      );
      if (conflicts.length > 0) {
        throw Object.assign(new Error('edit_conflict'), {
          code: 'edit_conflict',
          body: { conflicts, case: { ...state } },
        });
      }
      Object.assign(state, fields);
      return {};
    },
  );
  return state;
}

describe('QaPlanDetail authoring', () => {
  const renderDetail = (d: QaPlanDetailWire, onOpenSession = vi.fn()) => {
    getQaPlan.mockResolvedValue(d);
    render(
      <QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} onOpenSession={onOpenSession} />,
    );
    return onOpenSession;
  };

  it('approves a draft plan with cases', async () => {
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-approve'));
    await waitFor(() => expect(mutations.approveQaPlan).toHaveBeenCalledWith('proj', 'p1'));
    expect(getQaPlan).toHaveBeenCalledTimes(2);
  });

  it('disables Approve on a plan with no cases', async () => {
    renderDetail(detail({ approved: false }));
    expect(await screen.findByTestId('qa-approve')).toBeDisabled();
  });

  it('edits a case inline, confirming that approval is revoked', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ cases: [qaCase('c1')] }));
    expect(await screen.findByTestId('qa-detail-approved-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-expected'), {
      target: { value: 'Shows the receipt' },
    });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() =>
      expect(mutations.updateQaCase).toHaveBeenCalledWith('proj', 'p1', 'c1', {
        expected: 'Shows the receipt',
        expectedBase: { expected: 'It loads' },
      }),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/revokes approval/));
    confirm.mockRestore();
  });

  it('keeps concurrent agent edits to other fields when the case refreshes mid-edit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: 'Renamed' } });

    // The agent rewrites the steps while the form is open.
    getQaPlan.mockResolvedValue(
      detail({ approved: false, cases: [{ ...qaCase('c1'), steps: 'Agent steps', version: 2 }] }),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await waitFor(() => expect(getQaPlan).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() =>
      expect(mutations.updateQaCase).toHaveBeenCalledWith('proj', 'p1', 'c1', {
        title: 'Renamed',
        expectedBase: { title: 'Case c1' },
      }),
    );
    confirm.mockRestore();
  });

  it('refuses an overlapping edit once, then overwrites on the second Save', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-steps'), { target: { value: 'My steps' } });

    getQaPlan.mockResolvedValue(
      detail({ approved: false, cases: [{ ...qaCase('c1'), steps: 'Agent steps', version: 2 }] }),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await waitFor(() => expect(getQaPlan).toHaveBeenCalledTimes(2));
    serverHolds({ title: 'Case c1', steps: 'Agent steps', expected: 'It loads' });

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    expect(await screen.findByText(/changed \(steps\) while you were editing/)).toBeInTheDocument();
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      steps: 'My steps',
      expectedBase: { steps: 'Open the page' },
    });
    expect(screen.getByTestId('qa-case-form-steps')).toHaveValue('My steps');

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() =>
      expect(mutations.updateQaCase).toHaveBeenCalledWith('proj', 'p1', 'c1', {
        steps: 'My steps',
        expectedBase: { steps: 'Agent steps' },
      }),
    );
    confirm.mockRestore();
  });

  it('after a conflict, a second Save sends only the field the user typed in', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-steps'), { target: { value: 'My steps' } });

    // The agent changes the same field and an unrelated one.
    getQaPlan.mockResolvedValue(
      detail({
        approved: false,
        cases: [{ ...qaCase('c1'), steps: 'Agent steps', expected: 'Agent expected', version: 2 }],
      }),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await waitFor(() => expect(getQaPlan).toHaveBeenCalledTimes(2));
    // Untouched fields follow the latest saved text; the user's field keeps theirs.
    expect(screen.getByTestId('qa-case-form-expected')).toHaveValue('Agent expected');
    expect(screen.getByTestId('qa-case-form-steps')).toHaveValue('My steps');

    const server = serverHolds({
      title: 'Case c1',
      steps: 'Agent steps',
      expected: 'Agent expected',
    });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    expect(await screen.findByText(/changed \(steps\) while you were editing/)).toBeInTheDocument();
    expect(mutations.updateQaCase).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() => expect(mutations.updateQaCase).toHaveBeenCalledTimes(2));
    expect(server).toEqual({ title: 'Case c1', steps: 'My steps', expected: 'Agent expected' });
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      steps: 'My steps',
      expectedBase: { steps: 'Agent steps' },
    });
    confirm.mockRestore();
  });

  it('saves an edit that sets a live-updated field back to its earlier text', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [{ ...qaCase('c1'), steps: 'A' }] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));

    getQaPlan.mockResolvedValue(
      detail({ approved: false, cases: [{ ...qaCase('c1'), steps: 'B', version: 2 }] }),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qa_update', { detail: { projectId: 'proj', planId: 'p1' } }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('qa-case-form-steps')).toHaveValue('B'));

    fireEvent.change(screen.getByTestId('qa-case-form-steps'), { target: { value: 'A' } });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() =>
      expect(mutations.updateQaCase).toHaveBeenCalledWith('proj', 'p1', 'c1', {
        steps: 'A',
        expectedBase: { steps: 'B' },
      }),
    );
    expect(screen.queryByText(/while you were editing/)).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it('shows a server-side conflict when the case changed before the save reached it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // The page never sees the agent's change: every refresh still returns the old case.
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-steps'), { target: { value: 'My steps' } });

    const conflict = Object.assign(new Error('QA case changed since it was edited: steps'), {
      code: 'edit_conflict',
      body: {
        conflicts: ['steps'],
        case: { title: 'Case c1', steps: 'Server steps', expected: 'It loads' },
      },
    });
    mutations.updateQaCase.mockRejectedValueOnce(conflict).mockResolvedValue({});

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    expect(await screen.findByText(/changed \(steps\) while you were editing/)).toBeInTheDocument();
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      steps: 'My steps',
      expectedBase: { steps: 'Open the page' },
    });
    expect(screen.getByTestId('qa-case-form-steps')).toHaveValue('My steps');

    // The second Save is a deliberate overwrite of the text the server reported.
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() => expect(mutations.updateQaCase).toHaveBeenCalledTimes(2));
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      steps: 'My steps',
      expectedBase: { steps: 'Server steps' },
    });
    await waitFor(() => expect(screen.queryByTestId('qa-case-edit-form')).not.toBeInTheDocument());
    confirm.mockRestore();
  });

  it('a field typed back to its start is not overwritten after another field conflicts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    // Edit the steps and restore them, then change the title.
    fireEvent.change(screen.getByTestId('qa-case-form-steps'), { target: { value: 'Temp' } });
    fireEvent.change(screen.getByTestId('qa-case-form-steps'), {
      target: { value: 'Open the page' },
    });
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: 'Mine' } });

    // The agent changes both fields before the save; the page has not refreshed.
    const server = serverHolds({
      title: 'Agent title',
      steps: 'Agent steps',
      expected: 'It loads',
    });

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    expect(await screen.findByText(/changed \(title\) while you were editing/)).toBeInTheDocument();
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      title: 'Mine',
      expectedBase: { title: 'Case c1' },
    });

    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() => expect(mutations.updateQaCase).toHaveBeenCalledTimes(2));
    expect(mutations.updateQaCase).toHaveBeenLastCalledWith('proj', 'p1', 'c1', {
      title: 'Mine',
      expectedBase: { title: 'Agent title' },
    });
    expect(server).toEqual({ title: 'Mine', steps: 'Agent steps', expected: 'It loads' });
    confirm.mockRestore();
  });

  it('locks the edit form while a save is pending, then closes with what was sent', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish!: () => void;
    mutations.updateQaCase.mockImplementation(
      () => new Promise<object>((resolve) => (finish = () => resolve({}))),
    );
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));

    await waitFor(() => expect(mutations.updateQaCase).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('qa-case-form-fields')).toBeDisabled();
    expect(screen.getByTestId('qa-case-form-steps')).toBeDisabled();
    // A second submit while pending is ignored.
    fireEvent.submit(screen.getByTestId('qa-case-edit-form'));
    expect(mutations.updateQaCase).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByTestId('qa-case-edit-form')).not.toBeInTheDocument());
    confirm.mockRestore();
  });

  it('locks the add form while the add is pending and unlocks it on failure', async () => {
    let fail!: () => void;
    mutations.addQaCase.mockImplementation(
      () => new Promise<object>((_r, reject) => (fail = () => reject(new Error('nope')))),
    );
    renderDetail(detail({ approved: false, cases: [] }));
    fireEvent.click(await screen.findByTestId('qa-case-add'));
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: 'Pay' } });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() => expect(screen.getByTestId('qa-case-form-fields')).toBeDisabled());

    await act(async () => fail());
    await waitFor(() => expect(screen.getByTestId('qa-case-form-fields')).not.toBeDisabled());
    expect(screen.getByTestId('qa-case-form-title')).toHaveValue('Pay');
  });

  it('does not edit when the user cancels the approval warning', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail(detail({ cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-case-edit'));
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(mutations.updateQaCase).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('adds, reorders, and deletes cases on a draft plan', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail({ approved: false, cases: [qaCase('c1'), qaCase('c2')] }));
    const row1 = await screen.findByTestId('qa-case-row-c1');
    fireEvent.click(within(row1).getByTestId('qa-case-down'));
    await waitFor(() =>
      expect(mutations.reorderQaCases).toHaveBeenCalledWith('proj', 'p1', ['c2', 'c1']),
    );

    fireEvent.click(within(screen.getByTestId('qa-case-row-c2')).getByTestId('qa-case-delete'));
    await waitFor(() => expect(mutations.deleteQaCase).toHaveBeenCalledWith('proj', 'p1', 'c2'));

    fireEvent.click(screen.getByTestId('qa-case-add'));
    fireEvent.change(screen.getByTestId('qa-case-form-title'), { target: { value: ' Pay ' } });
    fireEvent.click(screen.getByTestId('qa-case-form-save'));
    await waitFor(() =>
      expect(mutations.addQaCase).toHaveBeenCalledWith('proj', 'p1', {
        title: 'Pay',
        steps: '',
        expected: '',
      }),
    );
    confirm.mockRestore();
  });

  it('hides edit controls while a run is active', async () => {
    renderDetail(
      detail({ cases: [qaCase('c1')], runs: [run('r1', { status: 'running', finishedAt: null })] }),
    );
    expect(await screen.findByTestId('qa-detail-locked')).toHaveTextContent('Cancel it');
    expect(screen.queryByTestId('qa-case-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qa-case-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qa-revoke-approval')).not.toBeInTheDocument();
  });

  it('shows a refused mutation as an error', async () => {
    mutations.approveQaPlan.mockRejectedValue(new Error('Cannot approve a QA plan with no cases'));
    renderDetail(detail({ approved: false, cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-approve'));
    expect(await screen.findByText('Cannot approve a QA plan with no cases')).toBeInTheDocument();
  });

  it('opens the authoring chat', async () => {
    mutations.openQaAuthoringSession.mockResolvedValue({
      sessionId: 's9',
      agentId: 'proj-qa',
      created: false,
    });
    const onOpenSession = renderDetail(detail());
    fireEvent.click(await screen.findByTestId('qa-open-chat'));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('proj-qa', 's9'));
  });
});

describe('QaPlanDetail sign-off', () => {
  const renderDetail = (d: QaPlanDetailWire) => {
    getQaPlan.mockResolvedValue(d);
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
  };
  const passing = () => detail({ cases: [qaCase('c1')], runs: [run('r1')], signOffBlocker: null });

  it('signs off an all-pass plan after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(passing());
    const button = await screen.findByTestId('qa-sign-off');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mutations.signOffQaPlan).toHaveBeenCalledWith('proj', 'p1'));
    expect(getQaPlan).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('does not sign off when the user cancels the confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail(passing());
    fireEvent.click(await screen.findByTestId('qa-sign-off'));
    expect(confirm).toHaveBeenCalled();
    expect(mutations.signOffQaPlan).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('disables sign-off and shows why while the latest run is not all-pass', async () => {
    renderDetail(
      detail({
        cases: [qaCase('c1')],
        runs: [run('r1', { status: 'failed' })],
        signOffBlocker: 'Latest run is failed, not passed',
      }),
    );
    const button = await screen.findByTestId('qa-sign-off');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Latest run is failed, not passed');
    expect(screen.getByTestId('qa-detail-sign-off-note')).toHaveTextContent(
      'Latest run is failed, not passed',
    );
  });

  it('shows the server refusal when the gate closed before the click landed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mutations.signOffQaPlan.mockRejectedValue(new Error('Latest run is running, not passed'));
    renderDetail(passing());
    fireEvent.click(await screen.findByTestId('qa-sign-off'));
    expect(await screen.findByText('Latest run is running, not passed')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('hides sign-off on new and done plans and shows when a done plan was signed off', async () => {
    const done = passing();
    done.plan = {
      ...done.plan,
      status: 'done',
      signedOffAt: '2026-10-26 12:00:00',
      signedOffBy: 'u2',
    };
    renderDetail(done);
    expect(await screen.findByTestId('qa-detail-signed-off')).toHaveAttribute(
      'title',
      'Signed off by u2',
    );
    expect(screen.queryByTestId('qa-sign-off')).toBeNull();
    expect(screen.getByTestId('qa-detail-locked')).toHaveTextContent('Start a run to reopen');
  });

  it('hides sign-off on a plan that was never run', async () => {
    const fresh = detail({ cases: [qaCase('c1')] });
    fresh.plan = { ...fresh.plan, status: 'new' };
    renderDetail(fresh);
    await screen.findByTestId('qa-detail-status');
    expect(screen.queryByTestId('qa-sign-off')).toBeNull();
  });
});

describe('rerunButtonStates', () => {
  const pass = {
    verdict: 'pass' as const,
    caseVersion: 1,
    current: true,
    runId: 'r1',
    iteration: 1,
  };
  const fail = { ...pass, verdict: 'fail' as const };

  it('refuses both on unapproved plans and during an active run', () => {
    const draft = rerunButtonStates(detail({ approved: false, cases: [qaCase('c1')] }));
    expect(draft.full).toEqual({ enabled: false, title: 'Approve the plan before running it' });
    expect(draft.failedOnly.enabled).toBe(false);
    const running = rerunButtonStates(
      detail({
        cases: [qaCase('c1', fail)],
        runs: [run('r2', { iteration: 2, status: 'running' })],
      }),
    );
    expect(running.full).toEqual({ enabled: false, title: 'Run 2 is running' });
    expect(running.failedOnly.enabled).toBe(false);
  });

  it('enables failed-only only while some case lacks a current pass', () => {
    const mixed = rerunButtonStates(
      detail({ cases: [qaCase('c1', pass), qaCase('c2', fail)], runs: [run('r1')] }),
    );
    expect(mixed.full.enabled).toBe(true);
    expect(mixed.failedOnly).toEqual({
      enabled: true,
      title: 'Run the 1 case(s) without a current pass',
    });
    const stale = rerunButtonStates(
      detail({ cases: [qaCase('c1', { ...pass, current: false })], runs: [run('r1')] }),
    );
    expect(stale.failedOnly.enabled).toBe(true);
    const allPass = rerunButtonStates(detail({ cases: [qaCase('c1', pass)], runs: [run('r1')] }));
    expect(allPass.failedOnly).toEqual({
      enabled: false,
      title: 'Every case passed on its current version',
    });
  });
});

describe('QaPlanDetail reruns', () => {
  const fail = {
    verdict: 'fail' as const,
    caseVersion: 1,
    current: true,
    runId: 'r1',
    iteration: 1,
  };
  const renderDetail = (d: QaPlanDetailWire) => {
    getQaPlan.mockResolvedValue(d);
    render(<QaPlanDetail projectId="proj" planId="p1" onBack={() => {}} />);
  };

  it('shows Start run before the first run and starts a full run', async () => {
    renderDetail(detail({ cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-start-run'));
    await waitFor(() => expect(mutations.startQaRun).toHaveBeenCalledWith('proj', 'p1', 'full'));
    expect(screen.queryByTestId('qa-rerun-failed')).toBeNull();
  });

  it('reruns failed cases or the full plan', async () => {
    renderDetail(detail({ cases: [qaCase('c1', fail)], runs: [run('r1', { status: 'failed' })] }));
    fireEvent.click(await screen.findByTestId('qa-rerun-failed'));
    await waitFor(() =>
      expect(mutations.startQaRun).toHaveBeenCalledWith('proj', 'p1', 'failed_only'),
    );
    await waitFor(() => expect(screen.getByTestId('qa-rerun-full')).toBeEnabled());
    fireEvent.click(screen.getByTestId('qa-rerun-full'));
    await waitFor(() => expect(mutations.startQaRun).toHaveBeenCalledWith('proj', 'p1', 'full'));
  });

  it('asks before a rerun reopens a signed-off plan', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const done = detail({ cases: [qaCase('c1')], runs: [run('r1')], signOffBlocker: null });
    done.plan = { ...done.plan, status: 'done', signedOffAt: '2026-10-26 12:00:00' };
    renderDetail(done);
    fireEvent.click(await screen.findByTestId('qa-rerun-full'));
    expect(confirm).toHaveBeenCalled();
    expect(mutations.startQaRun).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('saves the auto-rerun toggle, environment, and max runs', async () => {
    mutations.getDeployEnvironments.mockResolvedValue({
      environments: [{ name: 'staging' }, { name: 'production' }],
    });
    renderDetail(detail({ cases: [qaCase('c1')] }));
    fireEvent.click(await screen.findByTestId('qa-auto-rerun-toggle'));
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', { autoRerun: false }),
    );
    await screen.findByRole('option', { name: 'staging' });
    await waitFor(() => expect(screen.getByTestId('qa-deploy-environment')).toBeEnabled());
    fireEvent.change(screen.getByTestId('qa-deploy-environment'), {
      target: { value: 'staging' },
    });
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', {
        deployEnvironment: 'staging',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('qa-max-iterations')).toBeEnabled());
    const max = screen.getByTestId('qa-max-iterations');
    fireEvent.change(max, { target: { value: '8' } });
    fireEvent.blur(max);
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', { maxIterations: 8 }),
    );
  });

  it('switches to the merge trigger and saves the branch and delay', async () => {
    mutations.getDeployEnvironments.mockResolvedValue({ environments: [] });
    mutations.getProjectBranches.mockResolvedValue({
      branches: [{ name: 'main' }, { name: 'release' }],
    });
    const base = detail({ cases: [qaCase('c1')] });
    renderDetail(base);
    fireEvent.change(await screen.findByTestId('qa-auto-rerun-trigger'), {
      target: { value: 'merge' },
    });
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', {
        autoRerunTrigger: 'merge',
      }),
    );
    expect(screen.queryByTestId('qa-auto-rerun-branch')).toBeNull();

    cleanup();
    const merge = detail({ cases: [qaCase('c1')] });
    merge.plan = { ...merge.plan, autoRerunTrigger: 'merge' };
    renderDetail(merge);
    expect(await screen.findByRole('option', { name: 'release' })).toBeInTheDocument();
    expect(mutations.getProjectBranches).toHaveBeenCalledWith('proj');
    expect(screen.queryByTestId('qa-deploy-environment')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('qa-auto-rerun-branch')).toBeEnabled());
    fireEvent.change(screen.getByTestId('qa-auto-rerun-branch'), { target: { value: 'release' } });
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', {
        autoRerunBranch: 'release',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('qa-auto-rerun-delay')).toBeEnabled());
    fireEvent.change(screen.getByTestId('qa-auto-rerun-delay'), { target: { value: '15' } });
    await waitFor(() =>
      expect(mutations.updateQaPlan).toHaveBeenCalledWith('proj', 'p1', {
        autoRerunDelayMinutes: 15,
      }),
    );
  });

  it('summarizes each trigger', () => {
    const plan = detail({}).plan;
    expect(autoRerunSummary({ ...plan, autoRerun: false })).toMatch(/off/);
    expect(autoRerunSummary({ ...plan, deployEnvironment: 'staging' })).toMatch(
      /deployment to staging/,
    );
    expect(
      autoRerunSummary({
        ...plan,
        autoRerunTrigger: 'merge',
        autoRerunBranch: 'main',
        autoRerunDelayMinutes: 10,
      }),
    ).toMatch(/merged into main and 10 more minutes pass/);
    expect(autoRerunSummary({ ...plan, autoRerunTrigger: 'merge' })).toMatch(/no branch chosen/);
  });

  it('shows where the auto-rerun loop stands', async () => {
    renderDetail(
      detail({
        cases: [qaCase('c1', fail)],
        runs: [run('r1', { status: 'failed' })],
        autoRerun: { kind: 'wait_deploy', message: 'Auto-rerun waits for staging.' },
      }),
    );
    expect(await screen.findByTestId('qa-auto-rerun-status')).toHaveTextContent(
      'Auto-rerun waits for staging.',
    );
  });
});
