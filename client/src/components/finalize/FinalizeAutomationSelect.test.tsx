import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinalizeAutomationSelect from './FinalizeAutomationSelect';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    updateSession: vi.fn(),
  },
}));

import { api } from '../../utils/api';

const sid = 'sess-1';

describe('FinalizeAutomationSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders current session automation level', () => {
    render(<FinalizeAutomationSelect sessionId={sid} session={{ finalize_automation: 'push' }} />);
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build and Push');
  });

  it('renders the "review" option as "Build and Review"', () => {
    render(
      <FinalizeAutomationSelect sessionId={sid} session={{ finalize_automation: 'review' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build and Review');
  });

  it('reflects a session automation level changed live mid-session', () => {
    const { rerender } = render(
      <FinalizeAutomationSelect sessionId={sid} session={{ finalize_automation: 'manual' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build');

    rerender(
      <FinalizeAutomationSelect sessionId={sid} session={{ finalize_automation: 'merge' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Auto Merge');
  });

  it('renders Consult when session is in consult mode', () => {
    render(
      <FinalizeAutomationSelect
        sessionId={sid}
        session={{ session_mode: 'consult', finalize_automation: 'push' }}
      />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Consult');
  });

  it('renders Consult for legacy ask_mode rows', () => {
    render(
      <FinalizeAutomationSelect
        sessionId={sid}
        session={{ finalize_automation: 'push', ask_mode: 1 }}
        legacyAskMode={true}
      />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Consult');
  });

  describe('atomic single-patch contract', () => {
    it('sends one patch with the new automation level via onControlChange', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ finalize_automation: 'manual' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-merge' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({ finalize_automation: 'merge' }),
      );
    });

    it('selecting Consult sends a single consult patch', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ finalize_automation: 'manual' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-consult' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({ session_mode: 'consult' }),
      );
    });

    it('legacy ask -> a ship level clears ask AND sets the level in ONE patch', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ finalize_automation: 'manual' }}
          legacyAskMode={true}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-review' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({
          ask_mode: false,
          finalize_automation: 'review',
        }),
      );
      expect(onControlChange!).toHaveBeenCalledTimes(1);
    });

    it('falls back to api.updateSession when no onControlChange handler is provided', async () => {
      (api.updateSession as any).mockResolvedValueOnce({});
      render(
        <FinalizeAutomationSelect sessionId={sid} session={{ finalize_automation: 'manual' }} />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-push' as any) as any);
      await waitFor(() =>
        expect(api.updateSession).toHaveBeenCalledWith(sid, { finalize_automation: 'push' }),
      );
    });
  });

  describe('Design folded into the dropdown', () => {
    it('renders Design and Consult alongside the ship levels', () => {
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: true, finalize_automation: 'manual' }}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      expect(screen.getByTestId('finalize-automation-option-design')).toBeInTheDocument();
      expect(screen.getByTestId('finalize-automation-option-consult')).toBeInTheDocument();
      expect(screen.getByTestId('finalize-automation-option-merge')).toBeInTheDocument();
    });

    it('shows the Design label when the session is in design mode', () => {
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'design', can_design_mode: true, finalize_automation: 'merge' }}
        />,
      );
      expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Design');
    });

    it('selecting Design sends a single { session_mode: design } patch', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: true, finalize_automation: 'manual' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-design' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({ session_mode: 'design' }),
      );
    });

    it('Design from a ship level clears ship intent in the SAME atomic patch (regression)', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: true, finalize_automation: 'merge' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-design' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({
          session_mode: 'design',
          finalize_automation: 'manual',
        }),
      );
      expect(onControlChange!).toHaveBeenCalledTimes(1);
    });

    it('legacy ask + ship -> Design clears both axes in the SAME atomic patch (regression)', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: true, finalize_automation: 'push' }}
          legacyAskMode={true}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-design' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({
          session_mode: 'design',
          ask_mode: false,
          finalize_automation: 'manual',
        }),
      );
      expect(onControlChange!).toHaveBeenCalledTimes(1);
    });

    it('selecting a ship level while in design resets to chat in the same patch', async () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'design', can_design_mode: true, finalize_automation: 'manual' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-push' as any) as any);
      await waitFor(() =>
        expect(onControlChange!).toHaveBeenCalledWith({
          session_mode: 'chat',
          finalize_automation: 'push',
        }),
      );
    });

    it('surfaces an error and does not crash when the atomic call rejects', async () => {
      const onControlChange = vi.fn().mockRejectedValue(new Error('design_mode_requires_worktree'));
      const onError = vi.fn();
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: true, finalize_automation: 'merge' }}
          onControlChange={onControlChange}
          onError={onError}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      fireEvent.click(screen.getByTestId('finalize-automation-option-design' as any) as any);
      await waitFor(() => expect(onError!).toHaveBeenCalledWith('design_mode_requires_worktree'));
    });

    it('disables Design and does not fire a change when the session has no worktree', () => {
      const onControlChange = vi.fn().mockResolvedValue(undefined);
      render(
        <FinalizeAutomationSelect
          sessionId={sid}
          session={{ session_mode: 'chat', can_design_mode: false, finalize_automation: 'manual' }}
          onControlChange={onControlChange}
        />,
      );
      fireEvent.click(screen.getByTestId('finalize-automation-select' as any) as any);
      const design = screen.getByTestId('finalize-automation-option-design');
      expect(design!).toBeDisabled();
      fireEvent.click(design as any);
      expect(onControlChange!).not.toHaveBeenCalled();
    });
  });
});
