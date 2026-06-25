import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EpicAutonomousPanel, { epicToAutonomousForm } from './EpicAutonomousPanel';

describe('EpicAutonomousPanel', () => {
  it('defaults missing Auto Merge state to enabled while preserving explicit opt-out', () => {
    expect(epicToAutonomousForm({ id: 'e1' }).autonomous_send_it).toBe(1);
    expect(epicToAutonomousForm({ id: 'e1', autonomous_send_it: null }).autonomous_send_it).toBe(1);
    expect(epicToAutonomousForm({ id: 'e1', autonomous_send_it: 0 }).autonomous_send_it).toBe(0);
  });

  it('edits PR base branch and toggles autonomous', () => {
    const onChange = vi.fn();

    render(
      <EpicAutonomousPanel
        form={epicToAutonomousForm({ id: 'e1', pr_base_branch: 'feature/x' })}
        onChange={onChange}
        modelConfig={null}
      />,
    );

    expect(screen.getByTestId('autonomous-pr-base-input')).toHaveValue('feature/x');
    fireEvent.click(screen.getByRole('switch', { name: 'Autonomous mode' } as any) as any);
    expect(onChange!).toHaveBeenCalledWith({ autonomous: 1 });
  });
});
