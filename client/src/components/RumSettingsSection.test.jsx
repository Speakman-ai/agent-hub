import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RumSettingsSection, { formatLastUsed } from './RumSettingsSection.jsx';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/export.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getRumSetupDraft: vi.fn(),
    startRumWizard: vi.fn(),
    getRumClients: vi.fn(),
    createRumClient: vi.fn(),
    revokeRumClient: vi.fn(),
  },
}));

vi.mock('../utils/export.js', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const projects = [{ id: 'demo', name: 'Demo' }];

const draft = {
  framework: 'next',
  typescript: true,
  packageManager: 'pnpm',
  cspHits: [{ path: 'next.config.js', source: 'header' }],
  recorder: { dependencyPresent: false, initDetected: false },
  plan: {
    alreadyInstrumented: false,
    targetFile: 'app/layout.tsx',
    injectionStyle: 'client-component',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getRumSetupDraft.mockResolvedValue({ projectId: 'demo', draft });
  api.getRumClients.mockResolvedValue({ projectId: 'demo', clients: [] });
});

describe('RumSettingsSection', () => {
  it('renders the empty-state when there are no projects', () => {
    render(<RumSettingsSection projects={[]} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it('scans the repo and shows detected framework + injection target', async () => {
    render(<RumSettingsSection projects={projects} />);
    await waitFor(() => expect(api.getRumSetupDraft).toHaveBeenCalledWith('demo'));
    const summary = await screen.findByTestId('rum-draft-summary');
    expect(summary).toHaveTextContent('Next.js');
    expect(summary).toHaveTextContent('app/layout.tsx');
    expect(summary).toHaveTextContent(/client component/i);
  });

  it('spawns the wizard and opens the session on success', async () => {
    api.startRumWizard.mockResolvedValueOnce({ sessionId: 'sess-1', agentId: 'agent-1' });
    const onOpenSession = vi.fn();
    render(<RumSettingsSection projects={projects} onOpenSession={onOpenSession} />);

    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i }));

    await waitFor(() => expect(api.startRumWizard).toHaveBeenCalledWith('demo'));
    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'sess-1', agentId: 'agent-1' }),
    );
  });

  it('shows an inline error when the wizard call rejects', async () => {
    api.startRumWizard.mockRejectedValueOnce(new Error('boom'));
    render(<RumSettingsSection projects={projects} />);
    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('mints an ingest token and reveals it once with a copy button', async () => {
    api.createRumClient.mockResolvedValueOnce({ id: 'c1', name: 'prod', token: 'rum_secrettoken' });
    render(<RumSettingsSection projects={projects} showToast={vi.fn()} />);
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('demo'));

    fireEvent.change(screen.getByPlaceholderText(/token name/i), {
      target: { value: 'prod' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));

    await waitFor(() => expect(api.createRumClient).toHaveBeenCalledWith('demo', 'prod'));
    const reveal = await screen.findByTestId('rum-fresh-token');
    expect(reveal).toHaveTextContent('rum_secrettoken');
    expect(reveal).toHaveTextContent(/not be shown again/i);

    fireEvent.click(screen.getByRole('button', { name: /Copy token/i }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('rum_secrettoken'));
  });

  it('lists existing clients and revokes after confirmation', async () => {
    api.getRumClients.mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: null }],
    });
    api.revokeRumClient.mockResolvedValueOnce({ revoked: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<RumSettingsSection projects={projects} showToast={vi.fn()} />);
    const list = await screen.findByTestId('rum-client-list');
    expect(list).toHaveTextContent('prod');
    expect(list).toHaveTextContent('rum_abc123');
    // Never-used token renders the formatted label, not a raw timestamp.
    expect(list).toHaveTextContent('never used');

    fireEvent.click(screen.getByRole('button', { name: /Revoke/i }));
    await waitFor(() => expect(api.revokeRumClient).toHaveBeenCalledWith('demo', 'c1'));
    confirmSpy.mockRestore();
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    api.getRumClients.mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: null }],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<RumSettingsSection projects={projects} />);
    await screen.findByTestId('rum-client-list');
    fireEvent.click(screen.getByRole('button', { name: /Revoke/i }));

    expect(api.revokeRumClient).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces an already-instrumented warning', async () => {
    api.getRumSetupDraft.mockResolvedValue({
      projectId: 'demo',
      draft: {
        ...draft,
        recorder: { dependencyPresent: true, initDetected: true },
        plan: { ...draft.plan, alreadyInstrumented: true },
      },
    });
    render(<RumSettingsSection projects={projects} />);
    expect(await screen.findByText(/already has a wired recorder/i)).toBeInTheDocument();
  });

  it('renders a used token with a relative label and never echoes a raw timestamp', async () => {
    const usedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    api.getRumClients.mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: usedAt }],
    });
    render(<RumSettingsSection projects={projects} />);
    const list = await screen.findByTestId('rum-client-list');
    expect(list).toHaveTextContent(/last used .*ago/i);
    // The raw ISO timestamp must not leak into the UI.
    expect(list).not.toHaveTextContent(usedAt);
  });

  it('discards a stale clients response after switching projects (race fix)', async () => {
    let resolveAlpha;
    const alphaClients = new Promise((resolve) => {
      resolveAlpha = resolve;
    });
    api.getRumClients.mockImplementation((pid) =>
      pid === 'alpha'
        ? alphaClients
        : Promise.resolve({
            projectId: pid,
            clients: [{ id: 'b1', name: 'beta-token', prefix: 'rum_bbb', lastUsedAt: null }],
          }),
    );

    const { rerender } = render(<RumSettingsSection projects={[{ id: 'alpha', name: 'Alpha' }]} />);
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('alpha'));

    // Switch to Beta while Alpha's request is still in flight.
    rerender(<RumSettingsSection projects={[{ id: 'beta', name: 'Beta' }]} />);
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('beta'));
    expect(await screen.findByTestId('rum-client-list')).toHaveTextContent('beta-token');

    // Alpha's late response carries another project's credentials — it must
    // be discarded, not rendered over Beta's list.
    resolveAlpha({
      projectId: 'alpha',
      clients: [{ id: 'a1', name: 'alpha-secret-token', prefix: 'rum_aaa', lastUsedAt: null }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByTestId('rum-client-list')).toHaveTextContent('beta-token');
    expect(screen.queryByText('alpha-secret-token')).not.toBeInTheDocument();
  });

  it('does not reveal a minted token after switching projects (mint race fix)', async () => {
    let resolveMint;
    const mintPromise = new Promise((resolve) => {
      resolveMint = resolve;
    });
    api.createRumClient.mockReturnValue(mintPromise);

    const { rerender } = render(
      <RumSettingsSection projects={[{ id: 'alpha', name: 'Alpha' }]} showToast={vi.fn()} />,
    );
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('alpha'));

    fireEvent.change(screen.getByPlaceholderText(/token name/i), { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: /Create token/i }));
    await waitFor(() => expect(api.createRumClient).toHaveBeenCalledWith('alpha', 'prod'));

    // Switch to Beta while the mint is still in flight.
    rerender(<RumSettingsSection projects={[{ id: 'beta', name: 'Beta' }]} showToast={vi.fn()} />);
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('beta'));

    // Alpha's mint resolves with a one-time secret — it must NOT be revealed
    // under the now-active Beta project.
    resolveMint({ id: 'a1', name: 'prod', token: 'rum_alpha_secret' });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByTestId('rum-fresh-token')).not.toBeInTheDocument();
    expect(screen.queryByText(/rum_alpha_secret/)).not.toBeInTheDocument();
    // The Create button is usable again in Beta (not stuck disabled).
    expect(screen.getByRole('button', { name: /Create token/i })).not.toBeDisabled();
  });

  it('does not focus a session or set state after switching projects mid-wizard (wizard race fix)', async () => {
    let resolveWizard;
    const wizardPromise = new Promise((resolve) => {
      resolveWizard = resolve;
    });
    api.startRumWizard.mockReturnValue(wizardPromise);
    const onOpenSession = vi.fn();

    const { rerender } = render(
      <RumSettingsSection
        projects={[{ id: 'alpha', name: 'Alpha' }]}
        onOpenSession={onOpenSession}
      />,
    );
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('alpha'));

    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i }));
    await waitFor(() => expect(api.startRumWizard).toHaveBeenCalledWith('alpha'));

    // Switch to Beta while the spawn is still in flight.
    rerender(
      <RumSettingsSection
        projects={[{ id: 'beta', name: 'Beta' }]}
        onOpenSession={onOpenSession}
      />,
    );
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('beta'));

    // Alpha's spawn resolves — it must not focus a session or echo its id
    // under the now-active Beta project.
    resolveWizard({ sessionId: 'sess-alpha', agentId: 'agent-1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/sess-alpha/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set up RUM/i })).not.toBeDisabled();
  });

  it('does not surface revoke feedback after switching projects mid-DELETE (revoke race fix)', async () => {
    let resolveRevoke;
    const revokePromise = new Promise((resolve) => {
      resolveRevoke = resolve;
    });
    api.getRumClients.mockImplementation((pid) =>
      pid === 'alpha'
        ? Promise.resolve({
            projectId: 'alpha',
            clients: [{ id: 'a1', name: 'alpha-token', prefix: 'rum_aaa', lastUsedAt: null }],
          })
        : Promise.resolve({
            projectId: 'beta',
            clients: [{ id: 'b1', name: 'beta-token', prefix: 'rum_bbb', lastUsedAt: null }],
          }),
    );
    api.revokeRumClient.mockReturnValue(revokePromise);
    const showToast = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { rerender } = render(
      <RumSettingsSection projects={[{ id: 'alpha', name: 'Alpha' }]} showToast={showToast} />,
    );
    expect(await screen.findByTestId('rum-client-list')).toHaveTextContent('alpha-token');

    fireEvent.click(screen.getByRole('button', { name: /Revoke/i }));
    await waitFor(() => expect(api.revokeRumClient).toHaveBeenCalledWith('alpha', 'a1'));

    // Switch to Beta while the DELETE is in flight.
    rerender(
      <RumSettingsSection projects={[{ id: 'beta', name: 'Beta' }]} showToast={showToast} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('rum-client-list')).toHaveTextContent('beta-token'),
    );

    // Alpha's revoke resolves — its success toast must not surface in Beta.
    resolveRevoke({ revoked: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).not.toHaveBeenCalledWith('Ingest token revoked.', 'success', 3000);
    confirmSpy.mockRestore();
  });
});

describe('formatLastUsed', () => {
  it('returns "never used" for null or empty input', () => {
    expect(formatLastUsed(null)).toBe('never used');
    expect(formatLastUsed('')).toBe('never used');
  });

  it('formats a parseable timestamp as a relative "last used …" label', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = formatLastUsed(recent);
    expect(out).toMatch(/^last used .*ago$/i);
    expect(out).not.toContain(recent);
  });

  it('falls back to "never used" for an unparseable value rather than echoing it', () => {
    expect(formatLastUsed('not-a-date')).toBe('never used');
  });
});
