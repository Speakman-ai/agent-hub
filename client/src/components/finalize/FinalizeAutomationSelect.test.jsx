import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinalizeAutomationSelect from './FinalizeAutomationSelect.jsx';

vi.mock('../../utils/api.js', () => ({
  api: {
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
    expect(screen.getByTestId('finalize-automation-select')).toHaveTextContent(
      'Push Automatically',
    );
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
});
