import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import OpenProjectWizard, { NEW_PROJECT_WIZARD_DRAFT_KEY } from './OpenProjectWizard.jsx';

vi.mock('../utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051/api',
  getAuthHeaders: () => ({}),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

describe('OpenProjectWizard layout', () => {
  beforeEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  it('renders full-screen chrome (header + Back button) when layout is fullscreen', () => {
    const onClose = vi.fn();
    render(<OpenProjectWizard layout="fullscreen" onClose={onClose} onProjectCreated={() => {}} />);

    expect(screen.getByRole('heading', { name: 'New Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    // The Acts I–V journey strip belongs to the adaptive flow now —
    // the legacy "I already have a folder" wizard must not render it.
    expect(screen.queryByTestId('new-project-journey')).not.toBeInTheDocument();
  });

  it('does not render the journey strip in modal layout', () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);

    expect(screen.queryByTestId('new-project-journey')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open Project' })).toBeInTheDocument();
  });
});
