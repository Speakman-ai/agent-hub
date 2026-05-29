import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinalizeSettingsSection from './FinalizeSettingsSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    startFinalizeWizard: vi.fn(),
  },
}));

const projects = [
  { id: 'demo', name: 'Demo' },
  { id: 'other', name: 'Other' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FinalizeSettingsSection', () => {
  it('renders the empty-state when there are no projects', () => {
    render(<FinalizeSettingsSection projects={[]} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it('renders the project picker and the Set up Finalize button', () => {
    render(<FinalizeSettingsSection projects={projects} />);
    expect(screen.getByRole('heading', { name: /Finalize Code Changes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set up Finalize/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Demo')).toBeInTheDocument();
  });

  it('calls startFinalizeWizard and opens the session on success', async () => {
    api.startFinalizeWizard.mockResolvedValueOnce({
      sessionId: 'sess-1',
      agentId: 'agent-1',
    });
    const onOpenSession = vi.fn();
    render(<FinalizeSettingsSection projects={projects} onOpenSession={onOpenSession} />);

    fireEvent.click(screen.getByRole('button', { name: /Set up Finalize/i }));

    await waitFor(() => {
      expect(api.startFinalizeWizard).toHaveBeenCalledWith('demo');
    });
    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        agentId: 'agent-1',
      });
    });
  });

  it('shows an inline error when the wizard call rejects', async () => {
    api.startFinalizeWizard.mockRejectedValueOnce(new Error('boom'));
    render(<FinalizeSettingsSection projects={projects} />);

    fireEvent.click(screen.getByRole('button', { name: /Set up Finalize/i }));
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('shows an inline error when the response has no sessionId', async () => {
    api.startFinalizeWizard.mockResolvedValueOnce({});
    render(<FinalizeSettingsSection projects={projects} />);

    fireEvent.click(screen.getByRole('button', { name: /Set up Finalize/i }));
    await waitFor(() => {
      expect(screen.getByText(/server did not return a wizard session id/i)).toBeInTheDocument();
    });
  });

  it('switches to a different project via the picker', () => {
    render(<FinalizeSettingsSection projects={projects} />);
    fireEvent.change(screen.getByDisplayValue('Demo'), { target: { value: 'other' } });
    expect(screen.getByDisplayValue('Other')).toBeInTheDocument();
  });
});
