import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import EpicPullsSection, { relationLabel } from './EpicPullsSection';

const getEpicPulls = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    getEpicPulls: (...args: any[]) => getEpicPulls(...args),
  },
}));

describe('relationLabel', () => {
  it('maps relations to labels', () => {
    expect(relationLabel('integration')).toBe('Ships branch');
    expect(relationLabel('targets')).toBe('Targets branch');
    expect(relationLabel('anything-else')).toBe('Targets branch');
  });
});

describe('EpicPullsSection', () => {
  beforeEach(() => getEpicPulls.mockReset());

  it('renders nothing when the epic has no related PRs', async () => {
    getEpicPulls.mockResolvedValue({ epicId: 'e1', featureBranch: 'feature/x', pulls: [] });
    const { container } = render(<EpicPullsSection projectId="p" epicId="e1" />);
    await waitFor(() => expect(getEpicPulls).toHaveBeenCalledWith('p', 'e1'));
    // Nothing to show → the section is not rendered.
    expect(container.querySelector('[data-testid="epic-pulls-section"]')).toBeNull();
  });

  it('lists PRs with relation + state and fires onOpenPull for native PRs', async () => {
    getEpicPulls.mockResolvedValue({
      epicId: 'e1',
      featureBranch: 'feature/x',
      pulls: [
        {
          number: 7,
          title: 'Ship the branch',
          state: 'open',
          merged: false,
          relation: 'integration',
          html_url: '/projects/p/pulls/7',
        },
        {
          number: 8,
          title: 'Ticket work',
          state: 'closed',
          merged: true,
          relation: 'targets',
          html_url: '/projects/p/pulls/8',
        },
      ],
    });
    const onOpenPull = vi.fn();
    render(<EpicPullsSection projectId="p" epicId="e1" onOpenPull={onOpenPull} />);

    await waitFor(() => expect(screen.getByTestId('epic-pulls-section')).toBeInTheDocument());
    expect(screen.getByText('Ship the branch')).toBeInTheDocument();
    expect(screen.getByText('Ships branch')).toBeInTheDocument();
    expect(screen.getByText('Targets branch')).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('epic-pull-7'));
    expect(onOpenPull).toHaveBeenCalledWith(7);
  });

  it('renders an external link for GitHub PR URLs', async () => {
    getEpicPulls.mockResolvedValue({
      epicId: 'e1',
      featureBranch: 'feature/x',
      pulls: [
        {
          number: 42,
          title: 'External PR',
          state: 'open',
          merged: false,
          relation: 'targets',
          html_url: 'https://github.com/acme/repo/pull/42',
        },
      ],
    });
    render(<EpicPullsSection projectId="p" epicId="e1" />);
    const row = await screen.findByTestId('epic-pull-42');
    expect(row.tagName).toBe('A');
    expect(row).toHaveAttribute('href', 'https://github.com/acme/repo/pull/42');
  });

  it('renders a native PR without a handler as a non-interactive div, not a disabled button', async () => {
    getEpicPulls.mockResolvedValue({
      epicId: 'e1',
      featureBranch: 'feature/x',
      pulls: [
        {
          number: 9,
          title: 'Native, no handler',
          state: 'open',
          merged: false,
          relation: 'targets',
          html_url: '/projects/p/pulls/9',
        },
      ],
    });
    render(<EpicPullsSection projectId="p" epicId="e1" />);
    const row = await screen.findByTestId('epic-pull-9');
    expect(row.tagName).toBe('DIV');
    expect(row).not.toHaveAttribute('disabled');
  });
});
