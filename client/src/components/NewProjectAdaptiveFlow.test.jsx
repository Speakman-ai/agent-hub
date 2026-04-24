import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProjectAdaptiveFlow, { inferWithGithub } from './NewProjectAdaptiveFlow.jsx';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '../utils/adaptiveQuestionnaire.js';

// Mock the audit transport layer so the flow test can drive Act IV and
// transition into Act V (landing) without needing a live server.
vi.mock('../utils/auditClient.js', () => ({
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
      { id: 'architect', label: 'Architect', suggestedAgentId: 'hub-lead' },
      { id: 'frontend', label: 'Frontend', suggestedAgentId: 'hub-frontend' },
    ],
  })),
  saveRoster: vi.fn(async () => ({
    tracks: [{ id: 'architect', agentId: 'hub-lead', custom: false }],
    updatedAt: '2026-04-23T21:00:00Z',
  })),
  fetchAgents: vi.fn(async () => [
    { id: 'hub-lead', name: 'Hub Lead' },
    { id: 'hub-frontend', name: 'Hub Frontend' },
  ]),
}));

describe('inferWithGithub', () => {
  it('returns true when integrations is the idk sentinel', () => {
    expect(inferWithGithub({ integrations: 'idk' })).toBe(true);
  });

  it('returns true when integrations is null or absent', () => {
    expect(inferWithGithub({ integrations: null })).toBe(true);
    expect(inferWithGithub({})).toBe(true);
    expect(inferWithGithub(null)).toBe(true);
  });

  it('returns true when integrations array includes "github"', () => {
    expect(inferWithGithub({ integrations: ['github', 'aws'] })).toBe(true);
  });

  it('returns false when integrations array omits "github"', () => {
    expect(inferWithGithub({ integrations: ['aws', 'db'] })).toBe(false);
    expect(inferWithGithub({ integrations: [] })).toBe(false);
  });
});

describe('NewProjectAdaptiveFlow', () => {
  let subscribeHandlers;
  let streamClose;
  let provision;
  let subscribe;

  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    subscribeHandlers = null;
    streamClose = vi.fn();
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x', projectId: 'proj-1' });
    subscribe = vi.fn().mockImplementation((wsUrl, handlers) => {
      subscribeHandlers = handlers;
      return { close: streamClose };
    });
  });

  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  async function runThroughQuestionnaire(opts = {}) {
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
    // step 1 — description
    fireEvent.change(screen.getByTestId('aq-description-input'), {
      target: { value: 'a cool thing' },
    });
    fireEvent.click(screen.getByTestId('aq-continue'));
    // step 2 — app type
    fireEvent.click(screen.getByTestId('aq-apptype-web-app'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    // step 3 — stack (recommended auto-selected)
    fireEvent.click(screen.getByTestId('aq-continue'));
    // step 4 — integrations
    if (opts.withGithub !== false) {
      fireEvent.click(screen.getByTestId('aq-integration-github'));
    } else {
      fireEvent.click(screen.getByTestId('aq-integration-db'));
    }
    fireEvent.click(screen.getByTestId('aq-continue'));
    // step 5 — identity (auth not selected → step skipped)
    fireEvent.change(screen.getByTestId('aq-name-input'), { target: { value: 'my-proj' } });
    fireEvent.click(screen.getByTestId('aq-visibility-private'));
    fireEvent.click(screen.getByTestId('aq-continue'));
    // step 6 — review → submit
    await act(async () => {
      fireEvent.click(screen.getByTestId('aq-submit'));
    });
    return { onClose, onProjectCreated };
  }

  it('transitions from questionnaire to provisioning view on submit', async () => {
    await runThroughQuestionnaire();
    expect(screen.getByTestId('new-project-adaptive-flow')).toBeInTheDocument();
    expect(screen.getByTestId('provisioning-status')).toBeInTheDocument();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('ws://x', expect.any(Object));
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
    fireEvent.click(screen.getByTestId('ps-repo-link'));
    expect(onProjectCreated).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/acme/my-proj',
      projectId: 'proj-1',
    });
  });

  it('surfaces provision() rejection as a failure-card synthesized event', async () => {
    provision.mockRejectedValueOnce(new Error('401 unauthorized'));
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
      fireEvent.click(screen.getByTestId('ps-success-close'));
    });
    expect(screen.getByTestId('post-scaffold-audit')).toBeInTheDocument();
    expect(streamClose).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still routes the close button to onClose when provisioning failed', async () => {
    const { onClose } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        error: { code: 5, message: 'gh push failed' },
      });
    });
    fireEvent.click(screen.getByTestId('ps-failure-close'));
    expect(streamClose).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
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
      fireEvent.click(screen.getByTestId('ps-success-close'));
    });
    // Wait for the audit to finish its initial load (so the roster picker
    // has pre-selected agents and the confirm button is enabled).
    await waitFor(() => {
      expect(screen.getByTestId('roster-agent-architect')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-confirm')).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('psa-confirm'));
    });
    // Landing rendered.
    await waitFor(() => {
      expect(screen.getByTestId('project-landing')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pl-repo-link')).toHaveAttribute(
      'href',
      'https://github.com/acme/my-proj',
    );
    // onProjectCreated / onClose are NOT fired yet — the user has to click
    // a next-step CTA to leave the landing.
    expect(onProjectCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the primary "Brief lead" CTA routes through onProjectCreated
    // with `action: 'chat'` + the assigned agent id. onClose is NOT called —
    // the host's onProjectCreated handler owns the view transition to avoid
    // a setState race where onClose would clobber the routing.
    fireEvent.click(screen.getByTestId('pl-next-chat-lead'));
    expect(onProjectCreated).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', agentId: 'hub-lead', action: 'chat' }),
    );
    expect(onClose).not.toHaveBeenCalled();
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
      fireEvent.click(screen.getByTestId('ps-success-close'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-skip')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('psa-skip'));
    expect(screen.queryByTestId('project-landing')).not.toBeInTheDocument();
    // onClose is NOT called when onProjectCreated fires — the host's
    // onProjectCreated handler owns the view transition.
    expect(onClose).not.toHaveBeenCalled();
    expect(onProjectCreated).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', skipped: true }),
    );
  });

  it('retry re-invokes provision and wipes previous events', async () => {
    provision.mockRejectedValueOnce(new Error('502'));
    await runThroughQuestionnaire();
    expect(screen.getByTestId('ps-failure')).toBeInTheDocument();
    provision.mockResolvedValueOnce({ jobId: 'job-2', wsUrl: 'ws://y' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ps-retry'));
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith('ws://y', expect.any(Object));
  });
});
