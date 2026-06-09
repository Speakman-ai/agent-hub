import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinalizeAutomationSelect from './FinalizeAutomationSelect.jsx';

vi.mock('../../utils/api.js', () => ({
  api: {
    setSessionAskMode: vi.fn(),
    updateSession: vi.fn(),
  },
}));

import { api } from '../../utils/api.js';

describe('FinalizeAutomationSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders current session automation level', () => {
    render(
      <FinalizeAutomationSelect sessionId="sess-1" session={{ finalize_automation: 'push' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build and Push');
  });

  it('renders the "review" option as "Build and Review"', () => {
    render(
      <FinalizeAutomationSelect sessionId="sess-1" session={{ finalize_automation: 'review' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build and Review');
  });

  it('reflects a session automation level changed live mid-session', () => {
    // Simulate the App-level flow: a `session-updated` WS event swaps the
    // `session` prop; the select must re-render the new level without a
    // remount (the user switched modes while coding).
    const { rerender } = render(
      <FinalizeAutomationSelect sessionId="sess-1" session={{ finalize_automation: 'manual' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Build');

    rerender(
      <FinalizeAutomationSelect sessionId="sess-1" session={{ finalize_automation: 'merge' }} />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Auto Merge');
  });

  it('persists a new level via PATCH session', async () => {
    api.updateSession.mockResolvedValueOnce({});
    render(
      <FinalizeAutomationSelect sessionId="sess-1" session={{ finalize_automation: 'manual' }} />,
    );
    fireEvent.click(screen.getByTestId('finalize-automation-select'));
    fireEvent.click(screen.getByTestId('finalize-automation-option-merge'));
    await waitFor(() => {
      expect(api.updateSession).toHaveBeenCalledWith('sess-1', { finalize_automation: 'merge' });
    });
  });

  it('renders Ask when session ask mode is active', () => {
    render(
      <FinalizeAutomationSelect
        sessionId="sess-1"
        session={{ finalize_automation: 'push' }}
        askMode={true}
      />,
    );
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent('Ask');
  });

  it('enables ask mode from the build selector', async () => {
    const onAskModeChange = vi.fn();
    render(
      <FinalizeAutomationSelect
        sessionId="sess-1"
        session={{ finalize_automation: 'manual' }}
        askMode={false}
        onAskModeChange={onAskModeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('finalize-automation-select'));
    fireEvent.click(screen.getByTestId('finalize-automation-option-ask'));
    await waitFor(() => {
      expect(onAskModeChange).toHaveBeenCalledWith(true);
    });
    expect(api.setSessionAskMode).not.toHaveBeenCalled();
    expect(api.updateSession).not.toHaveBeenCalled();
  });

  it('clears ask mode before selecting a build automation level', async () => {
    const onAskModeChange = vi.fn();
    api.updateSession.mockResolvedValueOnce({});
    render(
      <FinalizeAutomationSelect
        sessionId="sess-1"
        session={{ finalize_automation: 'manual' }}
        askMode={true}
        onAskModeChange={onAskModeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('finalize-automation-select'));
    fireEvent.click(screen.getByTestId('finalize-automation-option-review'));
    await waitFor(() => {
      expect(onAskModeChange).toHaveBeenCalledWith(false);
    });
    expect(api.setSessionAskMode).not.toHaveBeenCalled();
    expect(api.updateSession).toHaveBeenCalledWith('sess-1', { finalize_automation: 'review' });
  });

  it('falls back to the ask-mode API when no parent handler is provided', async () => {
    api.setSessionAskMode.mockResolvedValueOnce({ id: 'sess-1', ask_mode: 1 });
    render(
      <FinalizeAutomationSelect
        sessionId="sess-1"
        session={{ finalize_automation: 'manual' }}
        askMode={false}
      />,
    );
    fireEvent.click(screen.getByTestId('finalize-automation-select'));
    fireEvent.click(screen.getByTestId('finalize-automation-option-ask'));
    await waitFor(() => {
      expect(api.setSessionAskMode).toHaveBeenCalledWith('sess-1', true);
    });
  });
});
