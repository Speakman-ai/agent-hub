import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PrEnvironmentsSection, { ValidateResults } from './PrEnvironmentsSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPrEnvSettings: vi.fn(),
    updatePrEnvSettings: vi.fn(),
    validatePrEnvSettings: vi.fn(),
  },
}));

/**
 * Canonical "already configured" shape from the server. Tier 2 credential
 * fields may still be present in the response (the server keeps them for
 * legacy compat), but the UI no longer surfaces them — credentials are
 * inherited from infrastructure (registered Reviewer App + IMDS).
 */
function loadedServerState() {
  return {
    enabled: true,
    repoFullName: 'acme/widgets',
    previewHost: '*.preview.example.com',
    previewBaseUrl: 'https://pr-{{number}}.preview.example.com',
    certRenewalLive: true,
    portRangeMin: 8000,
    portRangeMax: 8999,
    // Tier 2 — present but ignored by the UI.
    githubAppId: '123456',
    githubInstallationId: '7890',
    githubPrivateKey: '',
    route53AccessKeyId: '',
    route53SecretAccessKey: '',
    route53HostedZoneId: 'Z0123',
  };
}

beforeEach(() => {
  api.getPrEnvSettings.mockResolvedValue(loadedServerState());
  api.updatePrEnvSettings.mockImplementation(async (payload) => ({
    ...loadedServerState(),
    ...payload,
  }));
  api.validatePrEnvSettings.mockResolvedValue({
    ok: false,
    checks: [
      { name: 'docker', pass: true, message: 'Docker daemon reachable.' },
      { name: 'nginx', pass: true, message: 'Writable: /etc/nginx/sites-{available,enabled}' },
      { name: 'github-app', pass: false, message: 'Access-tokens request failed (401): bad jwt' },
      {
        name: 'route53',
        pass: true,
        message: 'Hosted zone Z0123 reachable (instance role / default chain).',
      },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<PrEnvironmentsSection />', () => {
  it('loads server state and populates Tier 1 fields', async () => {
    render(<PrEnvironmentsSection />);

    await waitFor(() => expect(api.getPrEnvSettings).toHaveBeenCalled());

    expect((await screen.findByLabelText(/Repo \(owner\/name\)/i)).value).toBe('acme/widgets');
    expect(screen.getByLabelText(/Preview host/i).value).toBe('*.preview.example.com');
  });

  it('shows the inherited-credentials notice and does NOT render credential inputs', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Repo \(owner\/name\)/i);

    // Inherited-creds explainer is present.
    expect(screen.getByTestId('prenv-inherited-creds-notice')).toBeInTheDocument();

    // Tier 2 credential fields must NOT exist anywhere in the UI.
    expect(screen.queryByLabelText(/App ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Installation ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Private key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access key ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Hosted zone ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Secret access key/i)).not.toBeInTheDocument();
  });

  it('does not include any Tier 2 credential fields in the save payload', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Repo \(owner\/name\)/i);

    fireEvent.change(screen.getByLabelText(/Repo \(owner\/name\)/i), {
      target: { value: 'acme/gadgets' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(api.updatePrEnvSettings).toHaveBeenCalledTimes(1));

    const payload = api.updatePrEnvSettings.mock.calls[0][0];
    for (const k of [
      'githubAppId',
      'githubInstallationId',
      'githubPrivateKey',
      'route53AccessKeyId',
      'route53SecretAccessKey',
      'route53HostedZoneId',
    ]) {
      expect(payload, `must not include Tier 2 field ${k}`).not.toHaveProperty(k);
    }
    expect(payload.repoFullName).toBe('acme/gadgets');
  });

  it('renders per-check pass/fail after the Validate button is clicked', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByLabelText(/Repo \(owner\/name\)/i);

    fireEvent.click(screen.getByRole('button', { name: /^Validate$/ }));

    await waitFor(() => expect(api.validatePrEnvSettings).toHaveBeenCalled());

    expect(await screen.findByTestId('prenv-validate-results')).toBeInTheDocument();
    // Four named checks rendered with their server-supplied messages.
    expect(screen.getByTestId('prenv-check-docker')).toHaveTextContent(/reachable/i);
    expect(screen.getByTestId('prenv-check-nginx')).toHaveTextContent(/writable/i);
    expect(screen.getByTestId('prenv-check-github-app')).toHaveTextContent(/failed/i);
    expect(screen.getByTestId('prenv-check-route53')).toHaveTextContent(/reachable/i);
    // Overall banner reflects at-least-one failure.
    expect(screen.getByText(/one or more checks failed/i)).toBeInTheDocument();
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
            { name: 'github-app', pass: true, message: 'ok' },
            { name: 'route53', pass: true, message: 'ok' },
          ],
        }}
      />,
    );
    expect(screen.getByText(/all checks passed/i)).toBeInTheDocument();
    expect(screen.getByTestId('prenv-check-github-app')).toBeInTheDocument();
  });

  it('renders a top-level error message when validation fetch itself failed', () => {
    render(<ValidateResults error="Network down" />);
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });
});
