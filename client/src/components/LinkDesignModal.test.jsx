import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LinkDesignModal from './LinkDesignModal.jsx';

const DESIGNS = [
  { id: 'd1', name: 'Landing page', linkedProjects: [{ id: 'p1', name: 'Web' }] },
  { id: 'd2', name: 'Dashboard mockup' },
  { id: 'd3', name: 'Pricing page' },
];

describe('LinkDesignModal', () => {
  it('lists all designs and selects one', () => {
    const onSelect = vi.fn();
    render(<LinkDesignModal designs={DESIGNS} onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.getByText('Landing page')).toBeInTheDocument();
    expect(screen.getByText('Dashboard mockup')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('link-design-option-d2'));
    expect(onSelect).toHaveBeenCalledWith('d2');
  });

  it('filters by the search query', () => {
    render(<LinkDesignModal designs={DESIGNS} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search designs…'), {
      target: { value: 'pricing' },
    });
    expect(screen.getByText('Pricing page')).toBeInTheDocument();
    expect(screen.queryByText('Landing page')).toBeNull();
  });

  it('marks the current design as linked and disables re-selecting it', () => {
    const onSelect = vi.fn();
    render(
      <LinkDesignModal
        designs={DESIGNS}
        currentDesignId="d1"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const current = screen.getByTestId('link-design-option-d1');
    expect(current).toBeDisabled();
    fireEvent.click(current);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the unlink action only when a design is currently linked', () => {
    const onUnlink = vi.fn();
    const { rerender } = render(
      <LinkDesignModal
        designs={DESIGNS}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onUnlink={onUnlink}
      />,
    );
    expect(screen.queryByTestId('link-design-unlink')).toBeNull();

    rerender(
      <LinkDesignModal
        designs={DESIGNS}
        currentDesignId="d1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onUnlink={onUnlink}
      />,
    );
    fireEvent.click(screen.getByTestId('link-design-unlink'));
    expect(onUnlink).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there are no designs', () => {
    render(<LinkDesignModal designs={[]} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No designs yet/i)).toBeInTheDocument();
  });
});
