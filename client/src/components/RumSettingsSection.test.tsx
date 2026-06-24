import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RumSettingsSection, { formatLastUsed } from './RumSettingsSection';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/export';
import {
  isSessionReplayEnabled,
  setSessionReplayEnabled,
  isMaskAllEnabled,
  setReplayMaskingMode,
} from '../utils/sessionReplay';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getRumSetupDraft: vi.fn(),
    startRumWizard: vi.fn(),
    getRumClients: vi.fn(),
    createRumClient: vi.fn(),
    revokeRumClient: vi.fn(),
    updateProject: vi.fn(),
  },
}));

(vi as any).mock('../utils/export.js', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

// The replay toggle controls the Hub's own recorder; mock it so the test never
// imports rrweb or touches real localStorage-backed recording state.
(vi as any).mock('../utils/sessionReplay.js', () => ({
  isSessionReplayEnabled: vi.fn(() => true),
  setSessionReplayEnabled: vi.fn().mockResolvedValue(false),
  isMaskAllEnabled: vi.fn(() => true),
  setReplayMaskingMode: vi.fn().mockResolvedValue('passwords-only'),
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
  (api.getRumSetupDraft as any).mockResolvedValue({ projectId: 'demo', draft });
  (api.getRumClients as any).mockResolvedValue({ projectId: 'demo', clients: [] });
  (api.updateProject as any).mockResolvedValue({ id: 'demo' });
});

describe('RumSettingsSection', () => {
  it('renders the empty-state when there are no projects', () => {
    render(<RumSettingsSection projects={[]} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it('renders the session-replay toggle reflecting the enabled state (on by default)', () => {
    (isSessionReplayEnabled as any).mockReturnValueOnce(true);
    render(<RumSettingsSection projects={projects} />);
    const toggle = screen.getByTestId('rum-replay-toggle');
    expect(toggle!).toHaveAttribute('role', 'switch');
    expect(toggle!).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles session replay off, persisting the choice via setSessionReplayEnabled', async () => {
    (isSessionReplayEnabled as any).mockReturnValueOnce(true);
    const showToast = vi.fn();
    render(<RumSettingsSection projects={projects} showToast={showToast} />);

    const toggle = screen.getByTestId('rum-replay-toggle');
    expect(toggle!).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle as any);

    await waitFor(() => expect(setSessionReplayEnabled!).toHaveBeenCalledWith(false));
    expect(toggle!).toHaveAttribute('aria-checked', 'false');
    await waitFor(() =>
      expect(showToast!).toHaveBeenCalledWith(
        expect.stringMatching(/disabled/i),
        'success',
        expect.any(Number),
      ),
    );
  });

  it('defaults the masking toggle to on (mask all text & inputs) with no warning', () => {
    (isMaskAllEnabled as any).mockReturnValueOnce(true);
    render(<RumSettingsSection projects={projects} />);
    const toggle = screen.getByTestId('rum-mask-all-toggle');
    expect(toggle!).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('rum-mask-all-warning')).not.toBeInTheDocument();
  });

  it('switches to passwords-only masking and surfaces the content-capture warning', async () => {
    (isMaskAllEnabled as any).mockReturnValueOnce(true);
    const showToast = vi.fn();
    render(<RumSettingsSection projects={projects} showToast={showToast} />);

    const toggle = screen.getByTestId('rum-mask-all-toggle');
    expect(toggle!).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle as any);

    await waitFor(() => expect(setReplayMaskingMode!).toHaveBeenCalledWith(false));
    expect(toggle!).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('rum-mask-all-warning')).toBeInTheDocument();
    await waitFor(() =>
      expect(showToast!).toHaveBeenCalledWith(
        expect.stringMatching(/password fields only/i),
        'info',
        expect.any(Number),
      ),
    );
  });

  it('reflects a persisted passwords-only choice on mount (toggle off + warning)', () => {
    (isMaskAllEnabled as any).mockReturnValueOnce(false);
    render(<RumSettingsSection projects={projects} />);
    expect(screen.getByTestId('rum-mask-all-toggle')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('rum-mask-all-warning')).toBeInTheDocument();
  });

  it('scans the repo and shows detected framework + injection target', async () => {
    render(<RumSettingsSection projects={projects} />);
    await waitFor(() => expect(api.getRumSetupDraft).toHaveBeenCalledWith('demo'));
    const summary = await screen.findByTestId('rum-draft-summary');
    expect(summary!).toHaveTextContent('Next.js');
    expect(summary!).toHaveTextContent('app/layout.tsx');
    expect(summary!).toHaveTextContent(/client component/i);
  });

  it('spawns the wizard and opens the session on success (default passwords-only masking)', async () => {
    (api.startRumWizard as any).mockResolvedValueOnce({ sessionId: 'sess-1', agentId: 'agent-1' });
    const onOpenSession = vi.fn();
    render(<RumSettingsSection projects={projects} onOpenSession={onOpenSession} />);

    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i } as any) as any);

    await waitFor(() =>
      expect(api.startRumWizard).toHaveBeenCalledWith('demo', { maskAllText: false }),
    );
    await waitFor(() =>
      expect(onOpenSession!).toHaveBeenCalledWith({ sessionId: 'sess-1', agentId: 'agent-1' }),
    );
  });

  it('passes strict masking (maskAllText=true) to the wizard when selected', async () => {
    (api.startRumWizard as any).mockResolvedValueOnce({ sessionId: 'sess-2', agentId: 'agent-1' });
    render(<RumSettingsSection projects={projects} onOpenSession={vi.fn()} />);

    fireEvent.change(screen.getByTestId('rum-inject-mask-select' as any), {
      target: { value: 'mask-all' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i } as any) as any);

    await waitFor(() =>
      expect(api.startRumWizard).toHaveBeenCalledWith('demo', { maskAllText: true }),
    );
  });

  it('shows an inline error when the wizard call rejects', async () => {
    (api.startRumWizard as any).mockRejectedValueOnce(new Error('boom'));
    render(<RumSettingsSection projects={projects} />);
    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i } as any) as any);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('mints an ingest token and reveals it once with a copy button', async () => {
    (api.createRumClient as any).mockResolvedValueOnce({
      id: 'c1',
      name: 'prod',
      token: 'rum_secrettoken',
    });
    render(<RumSettingsSection projects={projects} showToast={vi.fn()} />);
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('demo'));

    fireEvent.change(screen.getByPlaceholderText(/token name/i as any), {
      target: { value: 'prod' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create token/i } as any) as any);

    await waitFor(() => expect(api.createRumClient).toHaveBeenCalledWith('demo', 'prod'));
    const reveal = await screen.findByTestId('rum-fresh-token');
    expect(reveal!).toHaveTextContent('rum_secrettoken');
    expect(reveal!).toHaveTextContent(/not be shown again/i);

    fireEvent.click(screen.getByRole('button', { name: /Copy token/i } as any) as any);
    await waitFor(() => expect(copyToClipboard!).toHaveBeenCalledWith('rum_secrettoken'));
  });

  it('lists existing clients and revokes after confirmation', async () => {
    (api.getRumClients as any).mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: null }],
    });
    (api.revokeRumClient as any).mockResolvedValueOnce({ revoked: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<RumSettingsSection projects={projects} showToast={vi.fn()} />);
    const list = await screen.findByTestId('rum-client-list');
    expect(list!).toHaveTextContent('prod');
    expect(list!).toHaveTextContent('rum_abc123');
    // Never-used token renders the formatted label, not a raw timestamp.
    expect(list!).toHaveTextContent('never used');

    fireEvent.click(screen.getByRole('button', { name: /Revoke/i } as any) as any);
    await waitFor(() => expect(api.revokeRumClient).toHaveBeenCalledWith('demo', 'c1'));
    confirmSpy.mockRestore();
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    (api.getRumClients as any).mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: null }],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<RumSettingsSection projects={projects} />);
    await screen.findByTestId('rum-client-list');
    fireEvent.click(screen.getByRole('button', { name: /Revoke/i } as any) as any);

    expect(api.revokeRumClient).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces an already-instrumented warning', async () => {
    (api.getRumSetupDraft as any).mockResolvedValue({
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
    (api.getRumClients as any).mockResolvedValue({
      projectId: 'demo',
      clients: [{ id: 'c1', name: 'prod', prefix: 'rum_abc123', lastUsedAt: usedAt }],
    });
    render(<RumSettingsSection projects={projects} />);
    const list = await screen.findByTestId('rum-client-list');
    expect(list!).toHaveTextContent(/last used .*ago/i);
    // The raw ISO timestamp must not leak into the UI.
    expect(list!).not.toHaveTextContent(usedAt);
  });

  it('discards a stale clients response after switching projects (race fix)', async () => {
    let resolveAlpha: any;
    const alphaClients = new Promise((resolve: any) => {
      resolveAlpha = resolve;
    });
    (api.getRumClients as any).mockImplementation((pid: any) =>
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
    let resolveMint: any;
    const mintPromise = new Promise((resolve: any) => {
      resolveMint = resolve;
    });
    (api.createRumClient as any).mockReturnValue(mintPromise);

    const { rerender } = render(
      <RumSettingsSection projects={[{ id: 'alpha', name: 'Alpha' }]} showToast={vi.fn()} />,
    );
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('alpha'));

    fireEvent.change(screen.getByPlaceholderText(/token name/i as any), {
      target: { value: 'prod' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create token/i } as any) as any);
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
    let resolveWizard: any;
    const wizardPromise = new Promise((resolve: any) => {
      resolveWizard = resolve;
    });
    (api.startRumWizard as any).mockReturnValue(wizardPromise);
    const onOpenSession = vi.fn();

    const { rerender } = render(
      <RumSettingsSection
        projects={[{ id: 'alpha', name: 'Alpha' }]}
        onOpenSession={onOpenSession}
      />,
    );
    await waitFor(() => expect(api.getRumClients).toHaveBeenCalledWith('alpha'));

    fireEvent.click(screen.getByRole('button', { name: /Set up RUM/i } as any) as any);
    await waitFor(() =>
      expect(api.startRumWizard).toHaveBeenCalledWith('alpha', { maskAllText: false }),
    );

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

    expect(onOpenSession!).not.toHaveBeenCalled();
    expect(screen.queryByText(/sess-alpha/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set up RUM/i })).not.toBeDisabled();
  });

  it('does not surface revoke feedback after switching projects mid-DELETE (revoke race fix)', async () => {
    let resolveRevoke: any;
    const revokePromise = new Promise((resolve: any) => {
      resolveRevoke = resolve;
    });
    (api.getRumClients as any).mockImplementation((pid: any) =>
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
    (api.revokeRumClient as any).mockReturnValue(revokePromise);
    const showToast = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { rerender } = render(
      <RumSettingsSection projects={[{ id: 'alpha', name: 'Alpha' }]} showToast={showToast} />,
    );
    expect(await screen.findByTestId('rum-client-list')).toHaveTextContent('alpha-token');

    fireEvent.click(screen.getByRole('button', { name: /Revoke/i } as any) as any);
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

    expect(showToast!).not.toHaveBeenCalledWith('Ingest token revoked.', 'success', 3000);
    confirmSpy.mockRestore();
  });

  it('reflects a persisted off state from isSessionReplayEnabled', async () => {
    (isSessionReplayEnabled as any).mockReturnValueOnce(false);
    render(<RumSettingsSection projects={projects} />);
    const toggle = await screen.findByTestId('rum-replay-toggle');
    expect(toggle!).toHaveAttribute('aria-checked', 'false');
  });

  // ── Per-project server-delivered replay policy ──────────────────────
  it('initializes the sample-rate form from the project.replay', async () => {
    render(
      <RumSettingsSection projects={[{ id: 'demo', name: 'Demo', replay: { sampleRate: 0.5 } }]} />,
    );
    const select = (await screen.findByTestId('rum-replay-sample-rate')) as HTMLSelectElement;
    expect(select.value).toBe('0.5');
    // The continuous-capture toggle is NOT part of this card (it ships with the
    // continuous recorder / opt-in cards 1103/1106).
    expect(screen.queryByTestId('rum-replay-continuous-toggle')).toBeNull();
  });

  it('defaults to off when the project has no replay config', async () => {
    render(<RumSettingsSection projects={projects} />);
    const select = (await screen.findByTestId('rum-replay-sample-rate')) as HTMLSelectElement;
    expect(select.value).toBe('0');
  });

  it('PATCHes the project with the chosen sample rate', async () => {
    render(<RumSettingsSection projects={projects} showToast={vi.fn()} />);
    const select = await screen.findByTestId('rum-replay-sample-rate');
    fireEvent.change(select, { target: { value: '0.25' } });
    await waitFor(() =>
      expect(api.updateProject as any).toHaveBeenCalledWith('demo', {
        replay: { sampleRate: 0.25 },
      }),
    );
  });

  it('persists an explicit sampleRate:0 (not null) when Off is selected', async () => {
    // Off must be unambiguous: an absent sampleRate would resolve to the client
    // default rate server/recorder-side, so "Off (0%)" must persist 0.
    render(
      <RumSettingsSection
        projects={[{ id: 'demo', name: 'Demo', replay: { sampleRate: 0.5 } }]}
        showToast={vi.fn()}
      />,
    );
    const select = await screen.findByTestId('rum-replay-sample-rate');
    fireEvent.change(select, { target: { value: '0' } });
    await waitFor(() =>
      expect(api.updateProject as any).toHaveBeenCalledWith('demo', {
        replay: { sampleRate: 0 },
      }),
    );
  });

  it('preserves an externally-set continuous flag when editing the sample rate', async () => {
    // The opt-in toggle lives in another card (1106); editing the rate here must
    // not clobber a `continuous` flag set there.
    render(
      <RumSettingsSection
        projects={[{ id: 'demo', name: 'Demo', replay: { sampleRate: 0.5, continuous: true } }]}
        showToast={vi.fn()}
      />,
    );
    const select = await screen.findByTestId('rum-replay-sample-rate');
    fireEvent.change(select, { target: { value: '0' } });
    await waitFor(() =>
      expect(api.updateProject as any).toHaveBeenCalledWith('demo', {
        replay: { sampleRate: 0, continuous: true },
      }),
    );
  });

  it('surfaces a save error and reverts the form', async () => {
    (api.updateProject as any).mockRejectedValueOnce(new Error('nope'));
    render(
      <RumSettingsSection
        projects={[{ id: 'demo', name: 'Demo', replay: { sampleRate: 0.5 } }]}
        showToast={vi.fn()}
      />,
    );
    const select = (await screen.findByTestId('rum-replay-sample-rate')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    expect(await screen.findByTestId('rum-replay-config-error')).toHaveTextContent('nope');
    await waitFor(() => expect(select.value).toBe('0.5'));
  });

  it('clears the saving flag when the project changes mid-save (no stuck-disabled controls)', async () => {
    // A save for project A that never resolves before the user switches away.
    (api.updateProject as any).mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(
      <RumSettingsSection
        projects={[{ id: 'A', name: 'A', replay: { sampleRate: 0.5 } }]}
        showToast={vi.fn()}
      />,
    );
    const selectA = (await screen.findByTestId('rum-replay-sample-rate')) as HTMLSelectElement;
    fireEvent.change(selectA, { target: { value: '1' } });
    // Save in flight → controls disabled.
    await waitFor(() => expect(selectA).toBeDisabled());

    // Switch to project B before A's save resolves.
    rerender(
      <RumSettingsSection
        projects={[{ id: 'B', name: 'B', replay: { sampleRate: 0.25 } }]}
        showToast={vi.fn()}
      />,
    );
    const selectB = (await screen.findByTestId('rum-replay-sample-rate')) as HTMLSelectElement;
    await waitFor(() => expect(selectB.value).toBe('0.25'));
    // B's control must be enabled even though A's save never settled.
    await waitFor(() => expect(selectB).not.toBeDisabled());
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
    expect(out!).toMatch(/^last used .*ago$/i);
    expect(out!).not.toContain(recent);
  });

  it('falls back to "never used" for an unparseable value rather than echoing it', () => {
    expect(formatLastUsed('not-a-date')).toBe('never used');
  });
});
