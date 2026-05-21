import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import PreviewSection, { isPreviewConfigured, mergeDraftIntoForm } from './PreviewSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPreviewEnvironmentDraft: vi.fn(),
    getProjectSecrets: vi.fn(),
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
});
