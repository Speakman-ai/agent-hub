import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProjectAdaptiveFlow, { inferWithGithub } from './NewProjectAdaptiveFlow';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '@shared/utils/adaptiveQuestionnaire';

// Mock the audit transport layer so the flow test can drive Act IV and
// transition into Act V (landing) without needing a live server.
//
// PostScaffoldAudit now runs in `createAgents` mode (one freshly-minted
// agent per track) — saveRoster's response carries the minted `agentId`s
// AND the created agent records, which the landing uses to render the
// per-row display name + per-track "Chat" actions.
(vi as any).mock('../utils/auditClient.js', () => ({
  fetchAuditReport: vi.fn(async () => ({
    projectId: 'proj-1',
    score: 88,
    categories: [{ id: 'lint', status: 'ok' }],
    findings: [{ id: 'f1', severity: 'warn', message: 'Needs test for auth' }],
    gaps: [],
  })),
  refreshAuditReport: vi.fn(async () => ({})),
  fetchRosterSuggestions: vi.fn(async () => ({
    tracks: [
      { id: 'architect', label: 'Architect' },
      { id: 'frontend', label: 'Frontend' },
    ],
  })),
  saveRoster: vi.fn(async () => ({
    tracks: [
      { id: 'architect', label: 'Architect', agentId: 'proj-1-architect', custom: true },
      { id: 'frontend', label: 'Frontend', agentId: 'proj-1-frontend', custom: true },
    ],
    agents: [
      { id: 'proj-1-architect', name: 'my-proj Architect', role: 'Architect' },
      { id: 'proj-1-frontend', name: 'my-proj Frontend', role: 'Frontend' },
    ],
    updatedAt: '2026-04-23T21:00:00Z',
  })),
}));

describe('inferWithGithub', () => {
  it('is false for Agent Hub-hosted projects regardless of integrations', () => {
    // The hosting answer is the single source of truth — Hub-hosted
    // projects never create a GitHub repo (connect later in Settings).
    expect(inferWithGithub({ integrations: 'idk' })).toBe(false);
    expect(inferWithGithub({ integrations: ['github', 'aws'] })).toBe(false);
    expect(inferWithGithub({ integrations: ['github'], hostOnAgentHub: true })).toBe(false);
  });

  it('honors integrations when GitHub hosting was chosen explicitly', () => {
    expect(inferWithGithub({ hostOnAgentHub: false, integrations: 'idk' })).toBe(true);
    expect(inferWithGithub({ hostOnAgentHub: false, integrations: null })).toBe(true);
    expect(inferWithGithub({ hostOnAgentHub: false, integrations: ['github', 'aws'] })).toBe(true);
    expect(inferWithGithub({ hostOnAgentHub: false, integrations: ['aws', 'db'] })).toBe(false);
    expect(inferWithGithub({ hostOnAgentHub: false, integrations: [] })).toBe(false);
  });

  it('defaults to true for a missing payload (legacy caller safety)', () => {
    expect(inferWithGithub(null)).toBe(true);
  });
});

describe('NewProjectAdaptiveFlow', () => {
  let subscribeHandlers: any;
  let streamClose: any;
  let provision: any;
  let subscribe: any;

  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    subscribeHandlers = null;
    streamClose = vi.fn();
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x', projectId: 'proj-1' });
    subscribe = vi.fn().mockImplementation((wsUrl: any, handlers: any) => {
      subscribeHandlers = handlers;
      return { close: streamClose };
    });
  });

  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  async function runThroughQuestionnaire(opts: any = {}) {
    const onClose = vi.fn();
    const onProjectCreated = vi.fn();
    render(
      <NewProjectAdaptiveFlow
        onClose={onClose}
        onProjectCreated={onProjectCreated}
        provision={provision}
        subscribe={subscribe}
        {...(opts.extraProps || {})}
      />,
    );
    // step 0 — project-type picker. Choose the code path so we drop into
    // the existing adaptive questionnaire.
    fireEvent.click(screen.getByTestId('ptp-code' as any) as any);
    // step 1 — description
    fireEvent.change(screen.getByTestId('aq-description-input' as any), {
      target: { value: 'a cool thing' },
    });
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 2 — app type
    fireEvent.click(screen.getByTestId('aq-apptype-web-app' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 3 — stack (recommended auto-selected)
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 4 — integrations
    if (opts.withGithub !== false) {
      fireEvent.click(screen.getByTestId('aq-integration-github' as any) as any);
    } else {
      fireEvent.click(screen.getByTestId('aq-integration-db' as any) as any);
    }
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 5 — hosting (Agent Hub default)
    fireEvent.click(screen.getByTestId('aq-hosting-agenthub' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 6 — identity (auth not selected → step skipped)
    fireEvent.change(screen.getByTestId('aq-name-input' as any), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 6 — review → submit
    await act(async () => {
      fireEvent.click(screen.getByTestId('aq-submit' as any) as any);
    });
    return { onClose, onProjectCreated };
  }

  it('transitions from questionnaire to provisioning view on submit', async () => {
    await runThroughQuestionnaire();
    expect(screen.getByTestId('new-project-adaptive-flow')).toBeInTheDocument();
    expect(screen.getByTestId('provisioning-status')).toBeInTheDocument();
    expect(provision!).toHaveBeenCalledTimes(1);
    expect(subscribe!).toHaveBeenCalledWith('ws://x', expect.any(Object));
  });

  it('feeds server events into the ProvisioningStatus reducer', async () => {
    await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'phase',
        phase: 'validate',
        status: 'ok',
        at: '2026-04-23T00:00:01Z',
      });
    });
    expect(screen.getByTestId('ps-phase-validate')).toHaveAttribute('data-status', 'ok');
  });

  it('renders success state when a done event with repoUrl arrives', async () => {
    const { onProjectCreated } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    expect(screen.getByTestId('ps-overall')).toHaveTextContent(/Project ready/);
    fireEvent.click(screen.getByTestId('ps-repo-link' as any) as any);
    expect(onProjectCreated!).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/acme/my-proj',
      projectId: 'proj-1',
    });
  });

  it('surfaces provision() rejection as a failure-card synthesized event', async () => {
    (provision as any).mockRejectedValueOnce(new Error('401 unauthorized'));
    await runThroughQuestionnaire();
    expect(screen.getByTestId('ps-failure')).toBeInTheDocument();
    expect(screen.getByTestId('ps-failure')).toHaveTextContent(/401 unauthorized/);
  });

  it('transitions to the post-scaffold audit view after a successful provisioning run', async () => {
    const { onClose } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    // The success "Done" button now advances into Act IV (audit) rather
    // than closing the wizard outright. The provisioning socket is torn
    // down eagerly since its terminal event has already landed.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-success-close' as any) as any);
    });
    expect(screen.getByTestId('post-scaffold-audit')).toBeInTheDocument();
    expect(streamClose!).toHaveBeenCalled();
    expect(onClose!).not.toHaveBeenCalled();
  });

  it('still routes the close button to onClose when provisioning failed', async () => {
    const { onClose } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        error: { code: 5, message: 'gh push failed' },
      });
    });
    fireEvent.click(screen.getByTestId('ps-failure-close' as any) as any);
    expect(streamClose!).toHaveBeenCalled();
    expect(onClose!).toHaveBeenCalledTimes(1);
  });

  it('passes withGithub=false when the user omits GitHub in integrations', async () => {
    await runThroughQuestionnaire({ withGithub: false });
    // Without github in integrations the gh-* phases should be absent
    expect(screen.queryByTestId('ps-phase-gh-create')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ps-phase-gh-push')).not.toBeInTheDocument();
  });

  it('advances from audit to the Act V landing after a successful roster save', async () => {
    const { onProjectCreated, onClose } = await runThroughQuestionnaire();
    // Finish provisioning with a repoUrl so the landing can display it.
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-success-close' as any) as any);
    });
    // Wait for the audit to finish its initial load. Post-scaffold runs in
    // create-agents mode — each track renders a name input the user can
    // edit before confirming. `initialRosterForCreate` pre-fills the name
    // from the project name ("my-proj Architect"), so the confirm button
    // is enabled immediately.
    await waitFor(() => {
      expect(screen.getByTestId('roster-agent-name-architect')).toBeInTheDocument();
    });
    expect(screen.getByTestId('roster-agent-name-architect')).toHaveValue('my-proj Architect');
    await waitFor(() => {
      expect(screen.getByTestId('psa-confirm')).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('psa-confirm' as any) as any);
    });
    // Landing rendered.
    await waitFor(() => {
      expect(screen.getByTestId('project-landing')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pl-repo-link')).toHaveAttribute(
      'href',
      'https://github.com/acme/my-proj',
    );

    // The roster panel hydrates from the server response — every row shows
    // the typed agent name (not "Unassigned") and exposes a per-row Chat
    // action wired to the minted `<projectId>-<trackId>` agent id.
    const architectRow = screen.getByTestId('pl-roster-row-architect');
    expect(architectRow!).toHaveTextContent('Architect');
    expect(architectRow!).toHaveTextContent('my-proj Architect');
    expect(architectRow!).not.toHaveTextContent(/Unassigned/i);
    expect(screen.getByTestId('pl-chat-architect')).not.toBeDisabled();

    // onProjectCreated / onClose are NOT fired yet — the user has to click
    // a next-step CTA to leave the landing.
    expect(onProjectCreated!).not.toHaveBeenCalled();
    expect(onClose!).not.toHaveBeenCalled();

    // Clicking the primary "Brief lead" CTA routes through onProjectCreated
    // with `action: 'chat'` + the minted agent id. onClose is NOT called —
    // the host's onProjectCreated handler owns the view transition to avoid
    // a setState race where onClose would clobber the routing.
    fireEvent.click(screen.getByTestId('pl-next-chat-lead' as any) as any);
    expect(onProjectCreated!).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        agentId: 'proj-1-architect',
        action: 'chat',
      }),
    );
    expect(onClose!).not.toHaveBeenCalled();
  });

  it('audit-skip bypasses the landing and closes the wizard', async () => {
    const { onProjectCreated, onClose } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-success-close' as any) as any);
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-skip')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('psa-skip' as any) as any);
    expect(screen.queryByTestId('project-landing')).not.toBeInTheDocument();
    // onClose is NOT called when onProjectCreated fires — the host's
    // onProjectCreated handler owns the view transition.
    expect(onClose!).not.toHaveBeenCalled();
    expect(onProjectCreated!).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', skipped: true }),
    );
  });

  it('retry re-invokes provision and wipes previous events', async () => {
    (provision as any).mockRejectedValueOnce(new Error('502'));
    await runThroughQuestionnaire();
    expect(screen.getByTestId('ps-failure')).toBeInTheDocument();
    (provision as any).mockResolvedValueOnce({ jobId: 'job-2', wsUrl: 'ws://y' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-retry' as any) as any);
    });
    expect(provision!).toHaveBeenCalledTimes(2);
    expect(subscribe!).toHaveBeenCalledWith('ws://y', expect.any(Object));
  });
});

describe('NewProjectAdaptiveFlow — project-type picker (step 0)', () => {
  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
  });
  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  it('renders the type picker as the initial view', () => {
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    expect(screen.getByTestId('project-type-picker')).toBeInTheDocument();
    expect(screen.getByTestId('ptp-code')).toBeInTheDocument();
    expect(screen.getByTestId('ptp-import')).toBeInTheDocument();
    expect(screen.getByTestId('ptp-workflow')).toBeInTheDocument();
    // Neither downstream view is mounted yet.
    expect(screen.queryByTestId('adaptive-questionnaire')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-project-form')).not.toBeInTheDocument();
  });

  it('signals import via onProjectCreated when the user picks import', () => {
    const onProjectCreated = vi.fn();
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={onProjectCreated} />);
    fireEvent.click(screen.getByTestId('ptp-import' as any) as any);
    expect(onProjectCreated!).toHaveBeenCalledWith({ action: 'import' });
    expect(screen.queryByTestId('adaptive-questionnaire')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-project-form')).not.toBeInTheDocument();
  });

  it('routes to the adaptive questionnaire when the user picks "code"', () => {
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-code' as any) as any);
    expect(screen.getByTestId('adaptive-questionnaire')).toBeInTheDocument();
    expect(screen.getByTestId('aq-description-input')).toBeInTheDocument();
  });

  it('routes to the workflow form when the user picks "workflow"', () => {
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    expect(screen.getByTestId('workflow-project-form')).toBeInTheDocument();
    expect(screen.getByTestId('wpf-name-input')).toBeInTheDocument();
  });

  it('hitting Back from step 1 of the questionnaire returns to the type picker', () => {
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-code' as any) as any);
    expect(screen.getByTestId('adaptive-questionnaire')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('aq-back' as any) as any);
    expect(screen.getByTestId('project-type-picker')).toBeInTheDocument();
  });

  it('clicking Close on the type picker fires onClose', () => {
    const onClose = vi.fn();
    render(<NewProjectAdaptiveFlow onClose={onClose} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-close' as any) as any);
    expect(onClose!).toHaveBeenCalledTimes(1);
  });
});

describe('NewProjectAdaptiveFlow — workflow (non-code) submit path', () => {
  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
  });
  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  it('disables the submit button until a name is entered', () => {
    const createWorkflowProject = vi.fn();
    render(
      <NewProjectAdaptiveFlow
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
        createWorkflowProject={createWorkflowProject}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    expect(screen.getByTestId('wpf-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('wpf-name-input' as any), {
      target: { value: 'Q3 Research' },
    });
    expect(screen.getByTestId('wpf-submit')).not.toBeDisabled();
  });

  it('shows a live slug preview derived from the project name', () => {
    render(<NewProjectAdaptiveFlow onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    fireEvent.change(screen.getByTestId('wpf-name-input' as any), {
      target: { value: 'My Research Project!!' },
    });
    expect(screen.getByTestId('wpf-slug-preview')).toHaveTextContent('my-research-project');
  });

  it('submits with mode:"workflow" and routes the host to the kanban view', async () => {
    const createWorkflowProject = vi
      .fn()
      .mockResolvedValue({ id: 'q3-research', mode: 'workflow' });
    const onProjectCreated = vi.fn();
    render(
      <NewProjectAdaptiveFlow
        onClose={vi.fn()}
        onProjectCreated={onProjectCreated}
        createWorkflowProject={createWorkflowProject}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    fireEvent.change(screen.getByTestId('wpf-name-input' as any), {
      target: { value: 'Q3 Research' },
    });
    fireEvent.change(screen.getByTestId('wpf-description-input' as any), {
      target: { value: 'Quarterly findings' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wpf-submit' as any) as any);
    });
    expect(createWorkflowProject!).toHaveBeenCalledWith({
      name: 'Q3 Research',
      description: 'Quarterly findings',
      color: expect.any(String),
      visibility: 'shared',
    });
    await waitFor(() =>
      expect(onProjectCreated!).toHaveBeenCalledWith({
        projectId: 'q3-research',
        action: 'task',
        mode: 'workflow',
      }),
    );
  });

  it('surfaces server-side errors inline without unmounting the form', async () => {
    const err = Object.assign(new Error('409: Project id already exists'), { status: 409 });
    const createWorkflowProject = vi.fn().mockRejectedValue(err);
    const onProjectCreated = vi.fn();
    render(
      <NewProjectAdaptiveFlow
        onClose={vi.fn()}
        onProjectCreated={onProjectCreated}
        createWorkflowProject={createWorkflowProject}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    fireEvent.change(screen.getByTestId('wpf-name-input' as any), {
      target: { value: 'Existing' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wpf-submit' as any) as any);
    });
    await waitFor(() => {
      expect(screen.getByTestId('wpf-error')).toHaveTextContent(/Project id already exists/);
    });
    expect(screen.getByTestId('workflow-project-form')).toBeInTheDocument();
    expect(onProjectCreated!).not.toHaveBeenCalled();
    // Submit button is re-enabled so the user can rename and retry.
    expect(screen.getByTestId('wpf-submit')).not.toBeDisabled();
  });

  it('forwards visibility=private when the user picks the Private option', async () => {
    const createWorkflowProject = vi
      .fn()
      .mockResolvedValue({ id: 'secret-plans', mode: 'workflow' });
    render(
      <NewProjectAdaptiveFlow
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
        createWorkflowProject={createWorkflowProject}
      />,
    );
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    fireEvent.change(screen.getByTestId('wpf-name-input' as any), {
      target: { value: 'Secret Plans' },
    });
    fireEvent.click(screen.getByTestId('wpf-visibility-private' as any) as any);
    await act(async () => {
      fireEvent.click(screen.getByTestId('wpf-submit' as any) as any);
    });
    expect(createWorkflowProject!).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Secret Plans', visibility: 'private' }),
    );
  });

  it('Back button returns to the type picker without invoking onClose', () => {
    const onClose = vi.fn();
    render(<NewProjectAdaptiveFlow onClose={onClose} onProjectCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ptp-workflow' as any) as any);
    fireEvent.click(screen.getByTestId('wpf-back' as any) as any);
    expect(screen.getByTestId('project-type-picker')).toBeInTheDocument();
    expect(onClose!).not.toHaveBeenCalled();
  });
});
