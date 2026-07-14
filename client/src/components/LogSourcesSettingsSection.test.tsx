import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LogSourcesSettingsSection, {
  formatLastIngest,
  buildCurlExample,
} from './LogSourcesSettingsSection';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/export';

// Mock the exact specifiers the component imports (no `.js`, no `as any`) so
// Vitest's static hoisting detection matches reliably.
vi.mock('../utils/api', () => ({
  api: {
    getLogSources: vi.fn(),
    getLogsMetrics: vi.fn(),
    createLogSource: vi.fn(),
    rotateLogSource: vi.fn(),
    revokeLogSource: vi.fn(),
    deleteLogSource: vi.fn(),
    startLogsWizard: vi.fn(),
  },
}));

vi.mock('../utils/export', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

// getServerBase reads connection config from localStorage — stub it so the
// curl/endpoint examples render a deterministic origin without touching it.
vi.mock('../utils/connection', () => ({
  getServerBase: vi.fn(() => 'https://hub.example.com'),
}));

const projects = [{ id: 'demo', name: 'Demo' }];

const activeSource = {
  id: 's1',
  projectId: 'demo',
  name: 'production-api',
  serviceName: 'checkout',
  environment: 'prod',
  tokenPrefix: 'ahlog_abcd1234',
  status: 'active',
  createdAt: 1_800_000_000_000,
  rotatedAt: null,
  revokedAt: null,
  lastIngestAt: null,
};

const metrics = {
  storage: {
    projectBytes: 1024 * 1024,
    dbBytes: 4 * 1024 * 1024,
    quotaBytes: 5 * 1024 * 1024 * 1024,
    retentionDays: 7,
    retentionLagRecords: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getLogSources as any).mockResolvedValue({ sources: [activeSource] });
  (api.getLogsMetrics as any).mockResolvedValue(metrics);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LogSourcesSettingsSection', () => {
  it('renders the empty-state when there are no projects', () => {
    render(<LogSourcesSettingsSection projects={[]} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it('labels ingest tokens as write-only server secrets, not browser secrets', async () => {
    render(<LogSourcesSettingsSection projects={projects} />);
    const warning = await screen.findByTestId('logs-writeonly-warning');
    expect(warning).toHaveTextContent(/write-only/i);
    expect(warning).toHaveTextContent(/never in browser\/client code/i);
  });

  it('shows quota, retention, stored bytes, and credential status', async () => {
    render(<LogSourcesSettingsSection projects={projects} />);
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalledWith('demo'));
    expect(screen.getByTestId('logs-retention')).toHaveTextContent('7 days');
    expect(screen.getByTestId('logs-quota')).toHaveTextContent('5 GB');
    expect(screen.getByTestId('logs-stored')).toHaveTextContent('1 MB');
    // Credential status badge for the source.
    expect(screen.getByTestId('logs-source-status')).toHaveTextContent('active');
  });

  it('reveals the plaintext token exactly once on create and copies it', async () => {
    (api.createLogSource as any).mockResolvedValue({
      ...activeSource,
      name: 'new-src',
      token: 'ahlog_PLAINTEXTONCE0000000000000000000000000000',
    });
    const showToast = vi.fn();
    render(<LogSourcesSettingsSection projects={projects} showToast={showToast} />);
    await screen.findByTestId('logs-source-list');

    fireEvent.change(screen.getByTestId('logs-new-name'), { target: { value: 'new-src' } });
    fireEvent.click(screen.getByTestId('logs-create-btn'));

    await waitFor(() =>
      expect(api.createLogSource).toHaveBeenCalledWith('demo', { name: 'new-src' }),
    );

    // One-time reveal block shows the plaintext token.
    const reveal = await screen.findByTestId('logs-fresh-token');
    expect(reveal).toHaveTextContent('ahlog_PLAINTEXTONCE0000000000000000000000000000');
    expect(screen.getByTestId('logs-fresh-token-value')).toHaveTextContent(
      'ahlog_PLAINTEXTONCE0000000000000000000000000000',
    );

    // Copy the token.
    fireEvent.click(screen.getByTestId('logs-copy-token'));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith(
        'ahlog_PLAINTEXTONCE0000000000000000000000000000',
      ),
    );

    // The reveal carries a "not shown again" warning — one-time semantics.
    expect(reveal).toHaveTextContent(/not be shown again/i);
  });

  it('does not reveal a token without an explicit create/rotate action', async () => {
    render(<LogSourcesSettingsSection projects={projects} />);
    await screen.findByTestId('logs-source-list');
    expect(screen.queryByTestId('logs-fresh-token')).not.toBeInTheDocument();
  });

  it('confirms before rotating and requires confirmation to proceed', async () => {
    (api.rotateLogSource as any).mockResolvedValue({
      ...activeSource,
      token: 'ahlog_ROTATEDTOKEN000000000000000000000000000000',
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LogSourcesSettingsSection projects={projects} />);
    await screen.findByTestId('logs-source-list');

    // Declined confirmation → no API call, no reveal.
    fireEvent.click(screen.getByTestId('logs-rotate'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.rotateLogSource).not.toHaveBeenCalled();
    expect(screen.queryByTestId('logs-fresh-token')).not.toBeInTheDocument();

    // Accepting confirmation → rotate + new one-time reveal.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('logs-rotate'));
    await waitFor(() => expect(api.rotateLogSource).toHaveBeenCalledWith('demo', 's1'));
    const reveal = await screen.findByTestId('logs-fresh-token');
    expect(reveal).toHaveTextContent('ahlog_ROTATEDTOKEN000000000000000000000000000000');
  });

  it('requires confirmation before revoking a token', async () => {
    (api.revokeLogSource as any).mockResolvedValue({ ...activeSource, status: 'revoked' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LogSourcesSettingsSection projects={projects} />);
    await screen.findByTestId('logs-source-list');

    fireEvent.click(screen.getByTestId('logs-revoke'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.revokeLogSource).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('logs-revoke'));
    await waitFor(() => expect(api.revokeLogSource).toHaveBeenCalledWith('demo', 's1'));
  });

  it('requires confirmation before deleting a source', async () => {
    (api.deleteLogSource as any).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LogSourcesSettingsSection projects={projects} />);
    await screen.findByTestId('logs-source-list');

    fireEvent.click(screen.getByTestId('logs-delete'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteLogSource).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('logs-delete'));
    await waitFor(() => expect(api.deleteLogSource).toHaveBeenCalledWith('demo', 's1'));
  });
});

describe('formatLastIngest', () => {
  it('returns "no logs yet" for null / falsy input', () => {
    expect(formatLastIngest(null)).toBe('no logs yet');
    expect(formatLastIngest(undefined)).toBe('no logs yet');
    expect(formatLastIngest(0)).toBe('no logs yet');
  });

  it('formats a recent epoch-ms timestamp as a relative "last log …" label', () => {
    expect(formatLastIngest(Date.now() - 5000)).toMatch(/^last log /);
  });
});

describe('buildCurlExample', () => {
  it('embeds the token as a Bearer credential against the batch endpoint', () => {
    const out = buildCurlExample('ahlog_TESTTOKEN');
    expect(out).toContain('Authorization: Bearer ahlog_TESTTOKEN');
    expect(out).toContain('/api/logs/ingest');
  });
});

describe('AI setup wizard button', () => {
  it('is hidden when no onOpenSession handler is provided', async () => {
    render(<LogSourcesSettingsSection projects={projects} />);
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalled());
    expect(screen.queryByTestId('logs-setup-wizard-button')).not.toBeInTheDocument();
  });

  it('starts the wizard and focuses the spawned session', async () => {
    (api.startLogsWizard as any).mockResolvedValue({ sessionId: 'sess-1', agentId: 'agent-1' });
    const onOpenSession = vi.fn();
    render(<LogSourcesSettingsSection projects={projects} onOpenSession={onOpenSession} />);
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('logs-setup-wizard-button'));

    await waitFor(() => expect(api.startLogsWizard).toHaveBeenCalledWith('demo'));
    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'sess-1', agentId: 'agent-1' }),
    );
  });

  it('surfaces a wizard error without focusing a session', async () => {
    (api.startLogsWizard as any).mockRejectedValue(new Error('boom'));
    const onOpenSession = vi.fn();
    render(<LogSourcesSettingsSection projects={projects} onOpenSession={onOpenSession} />);
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('logs-setup-wizard-button'));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('re-enables the button for a new project while an old wizard request is still pending', async () => {
    // Wizard request that never settles — mimics switching projects mid-flight.
    (api.startLogsWizard as any).mockReturnValue(new Promise(() => {}));
    const onOpenSession = vi.fn();
    const { rerender } = render(
      <LogSourcesSettingsSection projects={projects} onOpenSession={onOpenSession} />,
    );
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalledWith('demo'));

    // Start the wizard on project "demo" → button goes disabled and stays so
    // (the promise never resolves, so the guarded finally can't clear it).
    fireEvent.click(screen.getByTestId('logs-setup-wizard-button'));
    await waitFor(() => expect(screen.getByTestId('logs-setup-wizard-button')).toBeDisabled());

    // Switch to a different project while the request is still pending.
    rerender(
      <LogSourcesSettingsSection
        projects={[{ id: 'other', name: 'Other' }]}
        onOpenSession={onOpenSession}
      />,
    );
    await waitFor(() => expect(api.getLogSources).toHaveBeenCalledWith('other'));

    // The new project's button must NOT inherit the stale disabled state.
    expect(screen.getByTestId('logs-setup-wizard-button')).not.toBeDisabled();
  });
});
