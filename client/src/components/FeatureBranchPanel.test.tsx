import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FeatureBranchPanel from './FeatureBranchPanel';

describe('FeatureBranchPanel', () => {
  it('keeps branch staging visible and generates a stable feature branch', () => {
    const onChange = vi.fn();
    render(
      <FeatureBranchPanel
        form={{ name: 'Platform Reliability', pr_base_branch: '' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Keep on feature branch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Keep on feature branch' }));
    expect(onChange).toHaveBeenCalledWith({ pr_base_branch: 'feature/platform-reliability' });
  });
});
