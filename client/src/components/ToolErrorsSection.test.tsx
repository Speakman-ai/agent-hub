import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ToolErrorsSection } from './SettingsPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getToolErrors: vi.fn(),
  },
}));

describe('ToolErrorsSection', () => {
  beforeEach(() => {
    (api.getToolErrors as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an empty-state hint when there are no projects', () => {
    render(<ToolErrorsSection projects={[]} />);
    expect(screen.getByText(/No projects yet/i)).toBeDefined();
    expect(api.getToolErrors).not.toHaveBeenCalled();
  });

  it('fetches tool errors for the default project and renders counts', async () => {
    (api.getToolErrors as any).mockResolvedValue({
      projectId: 'p1',
      since: '2026-03-20',
      total: 3,
      returned: 3,
      truncated: false,
      errors: [
        {
          timestamp: '2026-04-16T02:00:00Z',
          tool: 'Bash',
          action: 'npm test',
          errorType: 'exit 1',
          summary: 'tsx missing',
          date: '2026-04-16',
          raw: 'TOOL_ERROR | ... | ...',
        },
      ],
      countsByTool: { Bash: 2, Read: 1 },
      countsByErrorType: { 'exit 1': 2, ENOENT: 1 },
      countsByDate: { '2026-04-16': 3 },
    });

    render(<ToolErrorsSection projects={[{ id: 'p1', name: 'Project One' }]} />);

    await waitFor(() => expect(api.getToolErrors).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('tsx missing')).toBeDefined());

    // Error-type + tool buckets + listing may both render some of these
    // strings, so use getAllByText to stay non-brittle.
    expect(screen.getAllByText('exit 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ENOENT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bash').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
  });

  it('surfaces an error state when the API call fails', async () => {
    (api.getToolErrors as any).mockRejectedValue(new Error('boom'));
    render(<ToolErrorsSection projects={[{ id: 'p1', name: 'Project One' }]} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeDefined());
  });
});
