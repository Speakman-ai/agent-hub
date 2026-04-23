import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import NewProjectAdaptiveFlow, { inferWithGithub } from './NewProjectAdaptiveFlow.jsx';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY } from '../utils/adaptiveQuestionnaire.js';

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
    provision = vi.fn().mockResolvedValue({ jobId: 'job-1', wsUrl: 'ws://x' });
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
    expect(onProjectCreated).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme/my-proj' });
  });

  it('surfaces provision() rejection as a failure-card synthesized event', async () => {
    provision.mockRejectedValueOnce(new Error('401 unauthorized'));
    await runThroughQuestionnaire();
    expect(screen.getByTestId('ps-failure')).toBeInTheDocument();
    expect(screen.getByTestId('ps-failure')).toHaveTextContent(/401 unauthorized/);
  });

  it('closes the event stream when the user hits the close button on success', async () => {
    const { onClose } = await runThroughQuestionnaire();
    act(() => {
      subscribeHandlers.onEvent({
        type: 'done',
        repoUrl: 'https://github.com/acme/my-proj',
      });
    });
    fireEvent.click(screen.getByTestId('ps-success-close'));
    expect(streamClose).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('passes withGithub=false when the user omits GitHub in integrations', async () => {
    await runThroughQuestionnaire({ withGithub: false });
    // Without github in integrations the gh-* phases should be absent
    expect(screen.queryByTestId('ps-phase-gh-create')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ps-phase-gh-push')).not.toBeInTheDocument();
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
