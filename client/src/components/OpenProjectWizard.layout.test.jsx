import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import OpenProjectWizard, {
  JourneyProgressStrip,
  NEW_PROJECT_WIZARD_DRAFT_KEY,
} from './OpenProjectWizard.jsx';

vi.mock('../utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051/api',
  getAuthHeaders: () => ({}),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

describe('JourneyProgressStrip', () => {
  it('marks Entry and Questions active on wizard step 1', () => {
    render(<JourneyProgressStrip wizardStep={1} />);
    const nav = screen.getByTestId('new-project-journey');
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent('Entry');
    expect(nav).toHaveTextContent('Provisioning');
  });
});

describe('OpenProjectWizard layout', () => {
  beforeEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  it('renders full-screen journey chrome when layout is fullscreen', () => {
    const onClose = vi.fn();
    render(<OpenProjectWizard layout="fullscreen" onClose={onClose} onProjectCreated={() => {}} />);

    expect(screen.getByTestId('new-project-journey')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('does not render the journey strip in modal layout', () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);

    expect(screen.queryByTestId('new-project-journey')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open Project' })).toBeInTheDocument();
  });
});
