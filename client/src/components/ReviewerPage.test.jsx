import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReviewerPage from './ReviewerPage.jsx';
import { api } from '../utils/api.js';

/**
 * Component test for <ReviewerPage />.
 *
 * The page resolves the project's role:'reviewer' agent, loads its markdown
 * context files via api.getContext, and lets the user edit + save them via
 * api.saveContext. It also covers the no-reviewer edge case (project without
 * GitHub integration has no reviewer agent yet).
 */

vi.mock('../utils/api.js', () => ({
  api: {
    getContext: vi.fn(),
    saveContext: vi.fn(),
  },
}));

const reviewerAgent = {
  id: 'proj-1-reviewer',
  name: 'Demo Reviewer',
  role: 'reviewer',
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
});

describe('ReviewerPage', () => {
  it('loads and renders the reviewer agent context files', async () => {
    api.getContext.mockResolvedValue({
      'IDENTITY.md': '# Reviewer identity',
      'AGENTS.md': '# Shared agents context',
    });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    await waitFor(() => expect(api.getContext).toHaveBeenCalledWith('proj-1-reviewer'));
    expect(await screen.findByText('IDENTITY.md')).toBeTruthy();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
  });

  it('lets the user edit and save a file', async () => {
    api.getContext.mockResolvedValue({ 'IDENTITY.md': 'original' });
    api.saveContext.mockResolvedValue({ ok: true });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    const fileHeader = await screen.findByText('IDENTITY.md');
    fireEvent.click(fileHeader); // expand

    fireEvent.click(screen.getByText('Edit'));

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'updated body' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(api.saveContext).toHaveBeenCalledWith(
        'proj-1-reviewer',
        'IDENTITY.md',
        'updated body',
      ),
    );
  });

  it('shows an empty state when the project has no reviewer agent', async () => {
    render(<ReviewerPage projectId="proj-2" projects={[projectWithoutReviewer]} />);

    expect(await screen.findByText(/no reviewer yet/i)).toBeTruthy();
    expect(api.getContext).not.toHaveBeenCalled();
  });

  it('lets the user cancel an edit, restoring the original content', async () => {
    api.getContext.mockResolvedValue({ 'IDENTITY.md': 'original body' });

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    fireEvent.click(await screen.findByText('IDENTITY.md')); // expand
    fireEvent.click(screen.getByText('Edit'));

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'discarded edit' } });

    fireEvent.click(screen.getByText('Cancel'));

    // Back to read mode without saving.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(api.saveContext).not.toHaveBeenCalled();

    // Re-opening the editor shows the original content, not the discarded edit.
    fireEvent.click(screen.getByText('Edit'));
    expect(await screen.findByRole('textbox')).toHaveValue('original body');
  });

  it('renders an error state when loading the context files fails', async () => {
    api.getContext.mockRejectedValue(new Error('boom'));

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    expect(await screen.findByText(/could not load reviewer files: boom/i)).toBeTruthy();
  });

  it('renders an empty-files state when the reviewer has no context files', async () => {
    api.getContext.mockResolvedValue({});

    render(<ReviewerPage projectId="proj-1" projects={[projectWithReviewer]} />);

    await waitFor(() => expect(api.getContext).toHaveBeenCalledWith('proj-1-reviewer'));
    expect(await screen.findByText(/no markdown files found/i)).toBeTruthy();
  });
});
