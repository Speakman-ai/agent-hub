import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import PrEnvironmentsSection, { ValidateResults } from './PrEnvironmentsSection.jsx';
import { api } from '../utils/api.js';
import * as provisioningClient from '../utils/provisioningClient.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPrEnvSettings: vi.fn(),
    getLastPrEnvProvision: vi.fn(),
    startPrEnvProvision: vi.fn(),
    validatePrEnvSettings: vi.fn(),
  },
}));

/**
 * The wizard pipes WebSocket frames through `subscribeProvisioningEvents`.
 * We replace it with a controllable double so each test can assert against
 * a specific phase / log / done sequence.
 */
let lastSubscriber = null; // { onEvent, onClose, onError, close }
let lastSubscribeUrl = null;

beforeEach(() => {
  lastSubscriber = null;
  lastSubscribeUrl = null;

  vi.spyOn(provisioningClient, 'subscribeProvisioningEvents').mockImplementation(
    (wsUrl, handlers) => {
      lastSubscribeUrl = wsUrl;
      lastSubscriber = handlers;
      return {
        close: vi.fn(),
      };
    },
  );

  api.getPrEnvSettings.mockResolvedValue({
    enabled: false,
    repoFullName: 'acme/widgets',
    previewHost: 'preview.example.com',
    route53HostedZoneId: 'Z0123',
  });
  api.getLastPrEnvProvision.mockResolvedValue({ jobId: null });
  api.startPrEnvProvision.mockResolvedValue({
    jobId: 'job-abc',
    wsUrl: 'ws://test/api/settings/pr-env/provision/job-abc/events',
  });
  api.validatePrEnvSettings.mockResolvedValue({ ok: true, checks: [] });

  // Clean any stash left by previous tests so the mount sequence is
  // deterministic.
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Push an event to the active subscriber inside an `act()` so React renders. */
async function emit(ev) {
  await act(async () => {
    lastSubscriber.onEvent(ev);
  });
}

describe('<PrEnvironmentsSection /> — wizard inputs', () => {
  it('prefills the three operator inputs from saved settings', async () => {
    render(<PrEnvironmentsSection />);

    await waitFor(() => expect(api.getPrEnvSettings).toHaveBeenCalled());

    expect((await screen.findByLabelText(/Preview host/i)).value).toBe('preview.example.com');
    expect(screen.getByLabelText(/Route 53 hosted zone ID/i).value).toBe('Z0123');
    expect(screen.getByLabelText(/GitHub repo \(owner\/name\)/i).value).toBe('acme/widgets');
  });

  it('disables Provision until all three inputs are non-empty', async () => {
    api.getPrEnvSettings.mockResolvedValueOnce({
      enabled: false,
      repoFullName: '',
      previewHost: '',
      route53HostedZoneId: '',
    });
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);

    const btn = screen.getByTestId('prenv-provision-button');
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Preview host/i), {
      target: { value: 'preview.example.com' },
    });
    fireEvent.change(screen.getByLabelText(/Route 53 hosted zone ID/i), {
      target: { value: 'Z0123' },
    });
    fireEvent.change(screen.getByLabelText(/GitHub repo \(owner\/name\)/i), {
      target: { value: 'acme/widgets' },
    });

    expect(btn).not.toBeDisabled();
  });
});

describe('<PrEnvironmentsSection /> — provisioning flow', () => {
  it('starts a job and renders all 5 phase rows in pending state', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);

    fireEvent.click(screen.getByTestId('prenv-provision-button'));

    await waitFor(() => expect(api.startPrEnvProvision).toHaveBeenCalledTimes(1));
    expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled();
    expect(lastSubscribeUrl).toContain('job-abc');

    // All 5 phases are listed once the job kicks off.
    expect(screen.getByTestId('prenv-phase-detect-host')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-phase-write-tier3-config')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-phase-issue-cert')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-phase-attach-iam')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-phase-verify')).toBeInTheDocument();
  });

  it('reflects each phase status as events arrive (started → ok → failed → skipped)', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);
    fireEvent.click(screen.getByTestId('prenv-provision-button'));
    await waitFor(() => expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled());

    await emit({
      type: 'phase',
      phase: 'detect-host',
      status: 'started',
      at: '2026-05-06T00:00:00Z',
      seq: 0,
    });
    expect(screen.getByTestId('prenv-phase-detect-host')).toHaveTextContent(/running/i);

    await emit({
      type: 'phase',
      phase: 'detect-host',
      status: 'ok',
      message: 'containerized (AL2023)',
      at: '2026-05-06T00:00:01Z',
      seq: 1,
    });
    expect(screen.getByTestId('prenv-phase-detect-host')).toHaveTextContent(/ok/i);
    expect(screen.getByTestId('prenv-phase-detect-host-message')).toHaveTextContent(
      /containerized/i,
    );

    await emit({
      type: 'phase',
      phase: 'issue-cert',
      status: 'skipped',
      message: 'cert valid for 78 days',
      at: '2026-05-06T00:00:02Z',
      seq: 2,
    });
    expect(screen.getByTestId('prenv-phase-issue-cert')).toHaveTextContent(/skipped/i);

    await emit({
      type: 'phase',
      phase: 'attach-iam',
      status: 'failed',
      message: 'PutRolePolicy denied',
      at: '2026-05-06T00:00:03Z',
      seq: 3,
    });
    expect(screen.getByTestId('prenv-phase-attach-iam')).toHaveTextContent(/failed/i);
  });

  it('appends log lines to the live event stream', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);
    fireEvent.click(screen.getByTestId('prenv-provision-button'));
    await waitFor(() => expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled());

    await emit({
      type: 'log',
      phase: 'issue-cert',
      line: 'Requesting cert for *.preview.example.com',
      at: '2026-05-06T00:00:00Z',
      seq: 0,
    });
    await emit({
      type: 'log',
      phase: 'issue-cert',
      line: 'DNS challenge succeeded',
      at: '2026-05-06T00:00:01Z',
      seq: 1,
    });

    const stream = screen.getByTestId('prenv-event-stream');
    expect(stream).toHaveTextContent(/Requesting cert/);
    expect(stream).toHaveTextContent(/DNS challenge succeeded/);
    expect(screen.getAllByTestId('prenv-event-line')).toHaveLength(2);
  });

  it('renders remediation cards next to verify when done.partial arrives', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);
    fireEvent.click(screen.getByTestId('prenv-provision-button'));
    await waitFor(() => expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled());

    await emit({ type: 'phase', phase: 'verify', status: 'ok', at: '...', seq: 10 });
    await emit({
      type: 'done',
      outcome: 'partial',
      remediations: [
        {
          check: 'route53',
          severity: 'amber',
          headline: 'Attach IAM policy to ryan-ec2-ssm',
          detail: 'Wizard could not put-role-policy from this box.',
          actions: [
            { label: 'Copy CLI', kind: 'copy', payload: 'aws iam put-role-policy …' },
            {
              label: 'Open Route 53 console',
              kind: 'link',
              payload: 'https://console.aws.amazon.com/route53/',
            },
          ],
        },
      ],
      at: '2026-05-06T00:00:10Z',
      seq: 11,
    });

    // Card is rendered under the verify row only.
    expect(screen.getByTestId('prenv-phase-verify-remediations')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-remediation-route53')).toHaveTextContent(/Attach IAM/i);
    expect(screen.getByTestId('prenv-remediation-route53-action-copy')).toBeInTheDocument();
    expect(screen.getByTestId('prenv-remediation-route53-action-link')).toBeInTheDocument();

    // Other phases should NOT have a remediations container.
    expect(screen.queryByTestId('prenv-phase-attach-iam-remediations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prenv-phase-issue-cert-remediations')).not.toBeInTheDocument();
  });

  it('marks the run as not running once a done event arrives', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);
    fireEvent.click(screen.getByTestId('prenv-provision-button'));
    await waitFor(() => expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled());

    expect(screen.getByTestId('prenv-provision-button')).toBeDisabled();

    await emit({ type: 'done', outcome: 'ok', at: '2026-05-06T00:00:00Z', seq: 99 });
    await waitFor(() => expect(screen.getByTestId('prenv-provision-button')).not.toBeDisabled());
    expect(screen.getByTestId('prenv-done-banner')).toHaveTextContent(/all green/i);
  });

  it('resumes an in-flight job from localStorage on mount with ?since=-1', async () => {
    window.localStorage.setItem(
      'prenv-wizard-active-job',
      JSON.stringify({
        jobId: 'job-prev',
        wsUrl: 'ws://test/api/settings/pr-env/provision/job-prev/events',
      }),
    );
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);

    await waitFor(() => expect(provisioningClient.subscribeProvisioningEvents).toHaveBeenCalled());
    // The component reattached to the saved jobId, not a fresh one.
    expect(lastSubscribeUrl).toContain('job-prev');
    // No new POST happened — we resumed.
    expect(api.startPrEnvProvision).not.toHaveBeenCalled();
  });

  it('renders Last provisioned at … from /provision/last on mount', async () => {
    api.getLastPrEnvProvision.mockResolvedValueOnce({
      jobId: 'job-old',
      outcome: 'ok',
      finishedAt: '2026-05-05T12:00:00Z',
    });
    render(<PrEnvironmentsSection />);

    await screen.findByTestId('prenv-last-run');
    expect(screen.getByTestId('prenv-last-run')).toHaveTextContent(/Last provisioned/);
    expect(screen.getByTestId('prenv-last-run')).toHaveTextContent(/all green/i);
  });

  it('calls validate when Re-validate is clicked', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Preview host/i);

    fireEvent.click(screen.getByTestId('prenv-revalidate-button'));
    await waitFor(() => expect(api.validatePrEnvSettings).toHaveBeenCalled());
    expect(await screen.findByTestId('prenv-validate-results')).toBeInTheDocument();
  });
});

describe('<ValidateResults />', () => {
  it('renders an "all passed" banner when every check is pass', () => {
    render(
      <ValidateResults
        result={{
          ok: true,
          checks: [
            { name: 'docker', pass: true, message: 'ok' },
            { name: 'nginx', pass: true, message: 'ok' },
          ],
        }}
      />,
    );
    expect(screen.getByText(/all checks passed/i)).toBeInTheDocument();
    expect(screen.getByTestId('prenv-check-docker')).toBeInTheDocument();
  });

  it('renders a top-level error message when validation fetch itself failed', () => {
    render(<ValidateResults error="Network down" />);
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });
});
