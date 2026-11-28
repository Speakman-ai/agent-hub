import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrchestratedEpicsSection from './OrchestratedEpicsSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: { updateProject: vi.fn(async () => ({})) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OrchestratedEpicsSection', () => {
  it('defaults off and turns the setting on through updateProject', async () => {
    const onProjectsChange = vi.fn();
    render(<OrchestratedEpicsSection project={{ id: 'p1' }} onProjectsChange={onProjectsChange} />);
    const toggle = screen.getByTestId('project-orchestrated-epics-p1');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', { orchestratedEpics: true }),
    );
    expect(onProjectsChange).toHaveBeenCalled();
  });

  it('turns the setting off when it is on', async () => {
    render(<OrchestratedEpicsSection project={{ id: 'p1', orchestratedEpics: true }} />);
    const toggle = screen.getByTestId('project-orchestrated-epics-p1');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', { orchestratedEpics: false }),
    );
  });
});
