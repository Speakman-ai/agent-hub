import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProjectAdaptiveFlow, {
  inferWithGithub,
  inferWithToolchain,
} from './NewProjectAdaptiveFlow';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '@shared/utils/adaptiveQuestionnaire';

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

describe('inferWithToolchain', () => {
  it('is false for description-first / blank / idk stacks', () => {
    expect(inferWithToolchain(null)).toBe(false);
    expect(inferWithToolchain({})).toBe(false);
    expect(inferWithToolchain({ stack: 'idk' })).toBe(false);
    expect(inferWithToolchain({ stack: 'blank' })).toBe(false);
  });

  it('is true only for a known language starter id', () => {
    expect(inferWithToolchain({ stack: 'python-fastapi-uv' })).toBe(true);
    expect(inferWithToolchain({ stack: 'typescript-node-tsx' })).toBe(true);
    expect(inferWithToolchain({ stack: 'go-cobra' })).toBe(true);
    expect(inferWithToolchain({ stack: 'rust-axum' })).toBe(true);
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
    // step 2 — hosting
    if (opts.withGithub === true) {
      fireEvent.click(screen.getByTestId('aq-hosting-github' as any) as any);
    } else {
      fireEvent.click(screen.getByTestId('aq-hosting-agenthub' as any) as any);
    }
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 3 — identity
    fireEvent.change(screen.getByTestId('aq-name-input' as any), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private' as any) as any);
    fireEvent.click(screen.getByTestId('aq-continue' as any) as any);
    // step 4 — review → submit
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

  function fireInitialBuild(detail: any = {}) {
    act(() => {
      window.dispatchEvent(
        new CustomEvent('initial-build-ws', {
          detail: {
            type: 'initial_build_started',
            projectId: 'proj-1',
            sessionId: 'sess-build-1',
            agentId: 'proj-1-dev',
            ...detail,
          },
        }),
      );
    });
  }

  it('auto-opens the first build session instead of a landing picker', async () => {
    const { onClose, onProjectCreated } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    expect(screen.getByTestId('ps-opening-build')).toBeInTheDocument();
    expect(screen.queryByTestId('ps-success-close')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-landing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-next-kanban')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-next-skills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-next-open')).not.toBeInTheDocument();

    fireInitialBuild();
    expect(onProjectCreated!).toHaveBeenCalledWith({
      action: 'session',
      projectId: 'proj-1',
      sessionId: 'sess-build-1',
      agentId: 'proj-1-dev',
    });
    expect(streamClose!).toHaveBeenCalled();
    expect(onClose!).not.toHaveBeenCalled();
  });

  it('ignores first-build events for a different project', async () => {
    const { onProjectCreated } = await runThroughQuestionnaire();
    fireInitialBuild({ projectId: 'someone-else', sessionId: 'sess-other' });
    expect(onProjectCreated!).not.toHaveBeenCalled();
  });

  it('reveals a manual "Open project" escape if the first-build handoff never arrives', async () => {
    const { onClose, onProjectCreated } = await runThroughQuestionnaire({
      extraProps: { buildHandoffTimeoutMs: 20 },
    });
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    // Initially the flow waits for the broadcast — no escape yet.
    expect(screen.getByTestId('ps-opening-build')).toBeInTheDocument();
    expect(screen.queryByTestId('ps-open-project')).not.toBeInTheDocument();

    // The broadcast never arrives (creation failed / WS reconnect dropped it);
    // after the timeout the escape appears.
    const openBtn = await screen.findByTestId('ps-open-project');
    expect(screen.queryByTestId('ps-opening-build')).not.toBeInTheDocument();

    fireEvent.click(openBtn);
    expect(onProjectCreated!).toHaveBeenCalledWith({ action: 'task', projectId: 'proj-1' });
    expect(streamClose!).toHaveBeenCalled();
    expect(onClose!).not.toHaveBeenCalled();
  });

  it('does not reveal the escape when the handoff arrives before the timeout', async () => {
    const { onProjectCreated } = await runThroughQuestionnaire({
      extraProps: { buildHandoffTimeoutMs: 10000 },
    });
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    fireInitialBuild();
    expect(onProjectCreated!).toHaveBeenCalledWith({
      action: 'session',
      projectId: 'proj-1',
      sessionId: 'sess-build-1',
      agentId: 'proj-1-dev',
    });
    expect(screen.queryByTestId('ps-open-project')).not.toBeInTheDocument();
  });

  it('reveals the escape on a partial done when the handoff never arrives', async () => {
    const { onProjectCreated } = await runThroughQuestionnaire({
      withGithub: true,
      extraProps: { buildHandoffTimeoutMs: 20 },
    });
    act(() => {
      // Partial: local scaffold ready, GitHub step failed — the server still
      // dispatches the first build, so the client also waits for the handoff.
      subscribeHandlers.onEvent({
        type: 'done',
        partial: true,
        error: { code: 5, message: 'gh push failed' },
      });
    });
    expect(screen.getByTestId('ps-partial')).toBeInTheDocument();
    const openBtn = await screen.findByTestId('ps-open-project');
    fireEvent.click(openBtn);
    expect(onProjectCreated!).toHaveBeenCalledWith({ action: 'task', projectId: 'proj-1' });
  });

  // Regression: the readiness/roster step used to sit between provisioning
  // and the next view, blocking the user behind a 404 audit card and a
  // duplicate agent-roster picker. Provisioning already seeds the lead dev
  // and reviewer agents, so nothing may render that step again.
  it('never renders a readiness/roster step after provisioning', async () => {
    await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    fireInitialBuild();
    expect(screen.queryByTestId('post-scaffold-audit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('psa-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('psa-skip')).not.toBeInTheDocument();
    expect(screen.queryByText(/Readiness & roster/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-roster')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-audit-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-summary-band')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-landing')).not.toBeInTheDocument();
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

  it('passes withGithub=false when the user picks Agent Hub hosting', async () => {
    await runThroughQuestionnaire({ withGithub: false });
    expect(screen.queryByTestId('ps-phase-gh-create')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ps-phase-gh-push')).not.toBeInTheDocument();
  });

  it('does not list Wire tests / Wire lint for the description-first scaffold', async () => {
    await runThroughQuestionnaire();
    expect(screen.queryByTestId('ps-phase-wire-tests')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ps-phase-wire-lint')).not.toBeInTheDocument();
    expect(screen.queryByText('Wire tests')).not.toBeInTheDocument();
    expect(screen.queryByText('Wire lint')).not.toBeInTheDocument();
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
