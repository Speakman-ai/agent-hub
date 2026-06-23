import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReviewerPage from './ReviewerPage';
import { api } from '../utils/api';

/**
 * Component test for <ReviewerPage />.
 *
 * The page resolves the project's role:'reviewer' agent, loads its markdown
 * context files via api.getContext, and lets the user edit + save them via
 * api.saveContext. It also covers the no-reviewer edge case (project without
 * GitHub integration has no reviewer agent yet).
 */

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getContext: vi.fn(),
    getModelConfig: vi.fn(),
    saveContext: vi.fn(),
    updateAgent: vi.fn(),
    getMyAgentModelOverrides: vi.fn(),
    putMyAgentModelOverride: vi.fn(),
    deleteMyAgentModelOverride: vi.fn(),
  },
}));

const reviewerAgent = {
  id: 'proj-1-reviewer',
  name: 'Demo Reviewer',
  role: 'reviewer',
  engine: 'claude-code',
  model: 'claude-opus-4-8',
  active: true,
};

const projectWithReviewer = {
  id: 'proj-1',
  name: 'Demo',
  githubRepo: 'owner/repo',
  agents: [{ id: 'agent-lead', name: 'Lead', role: 'lead', active: true }, reviewerAgent],
};

const projectWithoutReviewer = {
  id: 'proj-2',
  name: 'NoGit',
  agents: [{ id: 'agent-solo', name: 'Solo', role: 'lead', active: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getMyAgentModelOverrides as any).mockResolvedValue({ agentModelOverrides: {} });
  (api.putMyAgentModelOverride as any).mockImplementation((id: any, body: any) =>
    Promise.resolve({ agentModelOverrides: { [id]: body.model } }),
  );
  (api.deleteMyAgentModelOverride as any).mockResolvedValue({ agentModelOverrides: {} });
  (api.getModelConfig as any).mockResolvedValue({
    defaultModel: 'claude-opus-4-8',
    engineDefaultModels: {
      'claude-code': 'claude-opus-4-8',
      'codex-cli': 'gpt-5-codex',
    },
    engineValidModels: {
      'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'],
      'codex-cli': ['gpt-5-codex', 'gpt-5'],
    },
  });
});

describe('ReviewerPage', () => {
  it('loads and renders the reviewer agent context files', async () => {
    (api.getContext as any).mockResolvedValue({
      'IDENTITY.md': '# Reviewer identity',
      'AGENTS.md': '# Shared agents context',
    });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    await waitFor(() => expect(api.getContext).toHaveBeenCalledWith('proj-1-reviewer'));
    expect(await screen.findByText('IDENTITY.md')).toBeTruthy();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
  });

  it('lets the user edit and save a file', async () => {
    (api.getContext as any).mockResolvedValue({ 'IDENTITY.md': 'original' });
    (api.saveContext as any).mockResolvedValue({ ok: true } as any);

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    const fileHeader = await screen.findByText('IDENTITY.md');
    fireEvent.click(fileHeader as any); // expand

    fireEvent.click(screen.getByText('Edit' as any) as any);

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'updated body' } } as any);

    fireEvent.click(screen.getByText('Save' as any) as any);

    await waitFor(() =>
      expect(api.saveContext).toHaveBeenCalledWith(
        'proj-1-reviewer',
        'IDENTITY.md',
        'updated body',
      ),
    );
  });

  it('saves the reviewer model as a per-user pick (not the shared row)', async () => {
    (api.getContext as any).mockResolvedValue({ 'IDENTITY.md': 'reviewer body' });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    const modelSelect = await screen.findByTestId('per-user-model-select');
    // No per-user pick yet → blank "Default" option selected.
    expect(modelSelect!).toHaveValue('');

    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-20250514' } } as any);

    // Selecting the model persists via the per-AGENT merge endpoint (only the
    // reviewer agent's key), never the whole-map PUT and never the shared row.
    await waitFor(() =>
      expect(api.putMyAgentModelOverride).toHaveBeenCalledWith('proj-1-reviewer', {
        model: 'claude-sonnet-4-20250514',
      }),
    );
    expect(api.updateAgent).not.toHaveBeenCalled();
  });

  it('saves the reviewer engine to the shared row and lists the new engine models', async () => {
    const onAgentsChange = vi.fn();
    (api.getContext as any).mockResolvedValue({ 'IDENTITY.md': 'reviewer body' });
    (api.updateAgent as any).mockResolvedValue({ ...reviewerAgent, engine: 'codex-cli' });

    render(
      <ReviewerPage
        projectId="proj-1"
        projects={[projectWithReviewer]}
        onAgentsChange={onAgentsChange}
      />,
    );

    fireEvent.change(await screen.findByTestId('reviewer-engine-select' as any), {
      target: { value: 'codex-cli' },
    });

    // The per-user model dropdown re-lists models for the newly selected engine.
    const modelSelect = await screen.findByTestId('per-user-model-select');
    expect(
      Array.from((modelSelect as any).options).map((option: any) => (option as any).value),
    ).toEqual(['', 'gpt-5-codex', 'gpt-5']);

    fireEvent.click(screen.getByRole('button', { name: /save engine/i } as any) as any);

    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith('proj-1-reviewer', { engine: 'codex-cli' }),
    );
    // Engine save must NOT write a model to the shared row.
    expect((api.updateAgent as any).mock.calls[0][1]).not.toHaveProperty('model');
    expect(onAgentsChange!).toHaveBeenCalled();
  });

  it('shows an empty state when the project has no reviewer agent', async () => {
    render(<ReviewerPage projectId="proj-2" projects={[projectWithoutReviewer]} />);

    expect(await screen.findByText(/no reviewer yet/i)).toBeTruthy();
    expect(api.getContext).not.toHaveBeenCalled();
  });

  it('lets the user cancel an edit, restoring the original content', async () => {
    (api.getContext as any).mockResolvedValue({ 'IDENTITY.md': 'original body' });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    fireEvent.click(await screen.findByText('IDENTITY.md' as any)); // expand
    fireEvent.click(screen.getByText('Edit' as any) as any);

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'discarded edit' } } as any);

    fireEvent.click(screen.getByText('Cancel' as any) as any);

    // Back to read mode without saving.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(api.saveContext).not.toHaveBeenCalled();

    // Re-opening the editor shows the original content, not the discarded edit.
    fireEvent.click(screen.getByText('Edit' as any) as any);
    expect(await screen.findByRole('textbox')).toHaveValue('original body');
  });

  it('renders an error state when loading the context files fails', async () => {
    (api.getContext as any).mockRejectedValue(new Error('boom'));

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    expect(await screen.findByText(/could not load reviewer files: boom/i)).toBeTruthy();
  });

  it('renders an empty-files state when the reviewer has no context files', async () => {
    (api.getContext as any).mockResolvedValue({});

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    await waitFor(() => expect(api.getContext).toHaveBeenCalledWith('proj-1-reviewer'));
    expect(await screen.findByText(/no markdown files found/i)).toBeTruthy();
  });
});
