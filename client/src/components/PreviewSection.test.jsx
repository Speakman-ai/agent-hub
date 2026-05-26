import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import PreviewSection, {
  isPreviewConfigured,
  mergeDraftIntoForm,
  formFromProject,
  buildBuildPayload,
} from './PreviewSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPreviewEnvironmentDraft: vi.fn(),
    getProjectSecrets: vi.fn(),
    getProjectPreviews: vi.fn(),
    purgeAllProjectPreviews: vi.fn(),
    stopPreview: vi.fn(),
    startPreviewWizard: vi.fn(),
    buildPreviewEnvironment: vi.fn(),
  },
}));

const monorepoDraft = {
  phase: 'confirm_compose',
  isMonorepo: true,
  composeCandidates: [
    {
      file: 'docker-compose.yml',
      services: [
        { name: 'web', entryPort: 3000 },
        { name: 'api', entryPort: 4000 },
      ],
      suggestedEntryService: 'web',
      suggestedEntryPort: 3000,
    },
  ],
  detected: {
    compose: {
      file: 'docker-compose.yml',
      entryService: 'web',
      entryPort: 3000,
      services: ['web', 'api'],
      healthPath: '/',
    },
    captureRoutes: ['/'],
    idleTTL: 600,
  },
  envVars: [{ key: 'API_KEY', sources: ['readme'], required: true }],
  readme: { readmePath: 'README.md', setupExcerpt: 'docker compose up', hasDockerHints: true },
  scriptHints: [],
  composeChecklist: [
    {
      id: 'compose-file-readable',
      category: 'mount',
      title: 'Compose file present for scan',
      description: 'Compose file was read for automated checks below.',
      status: 'pass',
    },
    {
      id: 'host-port-env-vars',
      category: 'ports',
      title: 'Host port uses AGENTHUB_HOST_PORT or FRONTEND_PORT',
      description: 'Map allocated port.',
      status: 'pass',
    },
  ],
};

const projects = [
  { id: 'proj-1', name: 'Demo', cwd: '/tmp/demo', prEnv: { preview: { enabled: false } } },
];

const configuredProjects = [
  {
    id: 'proj-1',
    name: 'Demo',
    cwd: '/tmp/demo',
    prEnv: {
      preview: {
        enabled: true,
        compose: { file: 'docker-compose.yml', entryService: 'web', entryPort: 5173 },
      },
    },
  },
];

describe('PreviewSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPreviewEnvironmentDraft.mockResolvedValue({ draft: monorepoDraft });
    api.getProjectSecrets.mockResolvedValue({ secrets: [] });
    api.getProjectPreviews.mockResolvedValue({ previews: [] });
  });

  it('shows Start setup before generating the form', async () => {
    render(<PreviewSection projects={projects} />);
    expect(screen.getByTestId('preview-start-setup-button')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-compose-section')).not.toBeInTheDocument();
  });

  it('does not auto-start the agent walkthrough', async () => {
    render(<PreviewSection projects={projects} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    expect(api.startPreviewWizard).not.toHaveBeenCalled();
  });

  it('lists running previews and supports purge all', async () => {
    api.getProjectPreviews.mockResolvedValue({
      previews: [
        {
          id: 'prev-1',
          sessionId: 'sess-1',
          sessionName: 'Test session',
          status: 'ready',
          kind: 'compose',
          composeProjectName: 'agenthub-session-sess-1',
          port: 4100,
          url: 'http://localhost:4100',
          worktreePath: '/tmp/wt',
          startedAt: '2026-05-22T00:00:00Z',
          lastActiveAt: '2026-05-22T00:01:00Z',
        },
      ],
    });
    api.purgeAllProjectPreviews.mockResolvedValue({ ok: true, stopped: 1, failed: [] });
    window.confirm = vi.fn(() => true);

    render(<PreviewSection projects={configuredProjects} />);
    await waitFor(() => expect(api.getProjectPreviews).toHaveBeenCalled());
    expect(screen.getByTestId('preview-running-panel')).toBeInTheDocument();
    expect(screen.getByText('Test session')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('preview-purge-all-button'));
    await waitFor(() => expect(api.purgeAllProjectPreviews).toHaveBeenCalledWith('proj-1'));
  });

  it('reveals editable form after Start setup', async () => {
    render(<PreviewSection projects={projects} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-start-setup-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('preview-compose-section')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('preview-setup-start-card')).not.toBeInTheDocument();
    expect(screen.getByText(/Monorepo/)).toBeInTheDocument();
    expect(screen.getByTestId('preview-compose-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('preview-checklist-compose-file-readable')).toBeInTheDocument();
  });

  it('shows validation error when entry service is missing', async () => {
    render(<PreviewSection projects={configuredProjects} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    await act(async () => {
      fireEvent.change(screen.getByTestId('preview-compose-entry-service'), {
        target: { value: '' },
      });
      fireEvent.click(screen.getByTestId('preview-build-button'));
    });
    expect(api.buildPreviewEnvironment).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-build-status')).toBeInTheDocument();
    expect(screen.getByTestId('preview-build-error-inline')).toHaveTextContent(
      /Select an entry service/i,
    );
  });

  it('shows compose form and Build and run when project is already configured', async () => {
    render(<PreviewSection projects={configuredProjects} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    expect(screen.getByTestId('preview-configured-banner')).toBeInTheDocument();
    expect(screen.getByTestId('preview-compose-section')).toBeInTheDocument();
    expect(screen.getByTestId('preview-build-button')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-setup-start-card')).not.toBeInTheDocument();
  });

  it('starts agent walkthrough only when user clicks Agent walkthrough', async () => {
    const onOpen = vi.fn();
    render(<PreviewSection projects={projects} onOpenSession={onOpen} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-start-setup-button'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('preview-walkthrough-button')).toBeInTheDocument(),
    );
    api.startPreviewWizard.mockResolvedValueOnce({ sessionId: 's1', agentId: 'a1' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-walkthrough-button'));
    });
    await waitFor(() => {
      expect(api.startPreviewWizard).toHaveBeenCalledWith('proj-1');
      expect(onOpen).toHaveBeenCalled();
    });
  });

  it('renders the per-project Ready timeout input alongside Idle TTL', async () => {
    render(<PreviewSection projects={configuredProjects} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    const input = screen.getByTestId('preview-ready-timeout');
    expect(input).toBeInTheDocument();
    // Empty by default for a project with no override saved — the helper
    // text must point operators at the 10-minute server default rather
    // than silently changing behavior.
    expect(input.value).toBe('');
    expect(input.min).toBe('5000');
    expect(input.max).toBe('1800000');
  });

  it('forwards readyTimeoutMs from the form to buildPreviewEnvironment when set', async () => {
    api.buildPreviewEnvironment.mockResolvedValue({ ok: true, steps: {} });
    render(<PreviewSection projects={configuredProjects} />);
    await waitFor(() => expect(api.getPreviewEnvironmentDraft).toHaveBeenCalled());
    await act(async () => {
      fireEvent.change(screen.getByTestId('preview-ready-timeout'), {
        target: { value: '1500000' },
      });
      fireEvent.click(screen.getByTestId('preview-build-button'));
    });
    await waitFor(() => expect(api.buildPreviewEnvironment).toHaveBeenCalled());
    const [, payload] = api.buildPreviewEnvironment.mock.calls[0];
    expect(payload.compose.readyTimeoutMs).toBe(1_500_000);
  });
});

describe('formFromProject — readyTimeoutMs', () => {
  it('reads a saved per-project override back into the form as a string', () => {
    const form = formFromProject({
      prEnv: {
        preview: {
          enabled: true,
          compose: { entryService: 'web', entryPort: 4200, readyTimeoutMs: 1_500_000 },
        },
      },
    });
    expect(form.composeReadyTimeoutMs).toBe('1500000');
  });

  it('returns empty string when the project has no override (server default applies)', () => {
    const form = formFromProject({
      prEnv: {
        preview: {
          enabled: true,
          compose: { entryService: 'web', entryPort: 4200 },
        },
      },
    });
    expect(form.composeReadyTimeoutMs).toBe('');
  });

  it('ignores non-numeric readyTimeoutMs and falls back to empty', () => {
    const form = formFromProject({
      prEnv: {
        preview: {
          enabled: true,
          compose: { entryService: 'web', entryPort: 4200, readyTimeoutMs: 'thirty minutes' },
        },
      },
    });
    expect(form.composeReadyTimeoutMs).toBe('');
  });
});

describe('buildBuildPayload — readyTimeoutMs', () => {
  const baseForm = {
    composeFile: 'docker-compose.yml',
    composeEntryService: 'web',
    composeEntryPort: 4200,
    composeEnvFile: '',
    healthPath: '/',
    idleTTL: 600,
    captureRoutes: ['/'],
    composeYaml: '',
    composeReadyTimeoutMs: '',
  };

  it('omits readyTimeoutMs when the input is blank', () => {
    const payload = buildBuildPayload(baseForm, [], { needsBootstrap: false });
    expect(payload.compose.readyTimeoutMs).toBeUndefined();
  });

  it('includes a parsed integer when the user typed a numeric value', () => {
    const payload = buildBuildPayload({ ...baseForm, composeReadyTimeoutMs: '1500000' }, [], {
      needsBootstrap: false,
    });
    expect(payload.compose.readyTimeoutMs).toBe(1_500_000);
  });

  it('trims surrounding whitespace before parsing', () => {
    const payload = buildBuildPayload({ ...baseForm, composeReadyTimeoutMs: '  900000  ' }, [], {
      needsBootstrap: false,
    });
    expect(payload.compose.readyTimeoutMs).toBe(900_000);
  });

  it('drops the field rather than sending NaN when the user types junk', () => {
    const payload = buildBuildPayload({ ...baseForm, composeReadyTimeoutMs: 'not-a-number' }, [], {
      needsBootstrap: false,
    });
    expect(payload.compose.readyTimeoutMs).toBeUndefined();
  });
});
