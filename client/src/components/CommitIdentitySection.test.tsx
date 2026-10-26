import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CommitIdentitySection from './CommitIdentitySection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: { updateProject: vi.fn(async () => ({})) },
}));

function mockGithubStatus(body: unknown) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body))) as any;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('CommitIdentitySection', () => {
  it('defaults off and turns the setting on through updateProject', async () => {
    mockGithubStatus({ connected: true, login: 'speakmanra' });
    const onProjectsChange = vi.fn();
    render(<CommitIdentitySection project={{ id: 'p1' }} onProjectsChange={onProjectsChange} />);
    const toggle = screen.getByTestId('project-commit-as-owner-p1');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', { commitAsOwner: { enabled: true } }),
    );
    expect(onProjectsChange).toHaveBeenCalled();
  });

  it('turns the setting off when it is on', async () => {
    mockGithubStatus({ connected: true, login: 'speakmanra' });
    render(<CommitIdentitySection project={{ id: 'p1', commitAsOwner: { enabled: true } }} />);
    fireEvent.click(screen.getByTestId('project-commit-as-owner-p1'));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', { commitAsOwner: { enabled: false } }),
    );
  });

  it('names the GitHub account sessions will commit as when enabled', async () => {
    mockGithubStatus({ connected: true, login: 'speakmanra' });
    render(<CommitIdentitySection project={{ id: 'p1', commitAsOwner: { enabled: true } }} />);
    expect(await screen.findByText(/commit as @speakmanra/)).toBeInTheDocument();
  });

  it('warns that the Agent Hub identity stays when GitHub is not connected', async () => {
    mockGithubStatus({ connected: false, login: null });
    render(<CommitIdentitySection project={{ id: 'p1', commitAsOwner: { enabled: true } }} />);
    expect(await screen.findByText(/have not connected GitHub/)).toBeInTheDocument();
  });
});
