import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PrEnvironmentsSection, { ValidateResults } from './PrEnvironmentsSection.jsx';
import { MASK } from '../utils/prEnvPayload.js';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPrEnvSettings: vi.fn(),
    updatePrEnvSettings: vi.fn(),
    validatePrEnvSettings: vi.fn(),
  },
}));

/** Canonical "already configured, secrets masked" shape from the server. */
function maskedServerState() {
  return {
    enabled: true,
    repoFullName: 'acme/widgets',
    previewHost: '*.preview.example.com',
    previewBaseUrl: 'https://pr-{{number}}.preview.example.com',
    certRenewalLive: true,
    portRangeMin: 8000,
    portRangeMax: 8999,
    githubAppId: '123456',
    githubInstallationId: '7890',
    githubPrivateKey: MASK,
    route53AccessKeyId: 'AKIA...',
    route53SecretAccessKey: MASK,
    route53HostedZoneId: 'Z0123',
  };
}

beforeEach(() => {
  api.getPrEnvSettings.mockResolvedValue(maskedServerState());
  api.updatePrEnvSettings.mockImplementation(async (payload) => ({
    ...maskedServerState(),
    ...payload,
    // Simulate server re-masking secrets in the response.
    githubPrivateKey: payload.githubPrivateKey ? MASK : '',
    route53SecretAccessKey: payload.route53SecretAccessKey ? MASK : '',
  }));
  api.validatePrEnvSettings.mockResolvedValue({
    ok: false,
    checks: [
      { name: 'docker', pass: true, message: 'Docker daemon reachable.' },
      { name: 'nginx', pass: true, message: 'Writable: /etc/nginx/sites-{available,enabled}' },
      { name: 'github-app', pass: false, message: 'Access-tokens request failed (401): bad jwt' },
      { name: 'route53', pass: true, message: 'Hosted zone Z0123 reachable.' },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<PrEnvironmentsSection />', () => {
  it('loads masked server state and displays the mask sentinel for untouched secrets', async () => {
    render(<PrEnvironmentsSection />);

    await waitFor(() => expect(api.getPrEnvSettings).toHaveBeenCalled());

    // Masked secrets surface as read-only masked inputs until "Edit" is clicked.
    expect((await screen.findByTestId('prenv-secret-masked-githubPrivateKey')).value).toBe(MASK);
    expect(screen.getByTestId('prenv-secret-masked-route53SecretAccessKey').value).toBe(MASK);

    // Tier 1 values populated from GET.
    expect(screen.getByLabelText(/Repo \(owner\/name\)/i).value).toBe('acme/widgets');
  });

  it('does NOT re-send the mask sentinel on save when a secret was not edited', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByTestId('prenv-secret-masked-githubPrivateKey');

    // User only touches Tier 1 (repo rename), never opens the secret fields.
    const repoInput = screen.getByLabelText(/Repo \(owner\/name\)/i);
    fireEvent.change(repoInput, { target: { value: 'acme/gadgets' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(api.updatePrEnvSettings).toHaveBeenCalledTimes(1));

    const payload = api.updatePrEnvSettings.mock.calls[0][0];
    // The critical invariant: masked secrets MUST NOT appear in the payload.
    expect(payload).not.toHaveProperty('githubPrivateKey');
    expect(payload).not.toHaveProperty('route53SecretAccessKey');
    // And the edited Tier 1 field flows through:
    expect(payload.repoFullName).toBe('acme/gadgets');
  });

  it('sends the new secret verbatim after the user explicitly edits it', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByTestId('prenv-secret-masked-route53SecretAccessKey');

    // Click "Edit" on the Route53 secret — this clears the masked field and
    // lets the user type a new value.
    fireEvent.click(screen.getByRole('button', { name: /edit secret access key/i }));
    const secretInput = await screen.findByTestId('prenv-secret-input-route53SecretAccessKey');
    fireEvent.change(secretInput, { target: { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(api.updatePrEnvSettings).toHaveBeenCalledTimes(1));
    const payload = api.updatePrEnvSettings.mock.calls[0][0];
    expect(payload.route53SecretAccessKey).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCY');
    // The OTHER secret, still untouched, must still be omitted.
    expect(payload).not.toHaveProperty('githubPrivateKey');
  });

  it('renders per-check pass/fail after the Validate button is clicked', async () => {
    render(<PrEnvironmentsSection />);
    await screen.findByTestId('prenv-secret-masked-githubPrivateKey');

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
