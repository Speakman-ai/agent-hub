import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import BackgroundAgentsSection from './BackgroundAgentsSection';
import { api } from '../utils/api';

/**
 * Project Settings → AI → Background Agents (Wiki agent).
 *
 * Pins the vertical slice: the section renders the Wiki agent with defaults
 * even when the project has no `backgroundAgents` config, and saving writes
 * the enable toggle + config through `PATCH /api/projects/:id`.
 */

vi.mock('../utils/api', () => ({
  api: {
    getProjectMembers: vi.fn(),
    getModelConfig: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const MODEL_CONFIG = {
  engineValidModels: {
    'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-5'],
  },
} as Record<string, any>;

const PROJECTS = [
  {
    id: 'proj-a',
    name: 'Project A',
    agents: [{ id: 'docs-1', role: 'docs', engine: 'claude-code', name: 'Docs' }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.getProjectMembers as any).mockResolvedValue({
    members: [{ userId: 'u1', username: 'ryan' }],
  });
  (api.getModelConfig as any).mockResolvedValue(MODEL_CONFIG);
  (api.updateProject as any).mockResolvedValue({
    backgroundAgents: { wiki: { enabled: true } },
  });
});

describe('BackgroundAgentsSection', () => {
  it('renders the Wiki agent disabled by default and saves an enable toggle', async () => {
    const onProjectsChange = vi.fn();
    const showToast = vi.fn();
    const { getByTestId, getByText } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={onProjectsChange}
        showToast={showToast}
      />,
    );

    expect(getByText('Background Agents')).toBeTruthy();
    await waitFor(() => expect(api.getProjectMembers).toHaveBeenCalledWith('proj-a'));

    const toggle = getByTestId('wiki-agent-enabled') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    const [pid, body] = (api.updateProject as any).mock.calls[0];
    expect(pid).toBe('proj-a');
    expect(body.backgroundAgents.wiki.enabled).toBe(true);
    expect(body.backgroundAgents.wiki.schedule).toBe('0 3 * * *');
    expect(onProjectsChange).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Background agents saved', 'success');
  });

  it('warns when the project has no docs agent', async () => {
    const { getByText } = render(
      <BackgroundAgentsSection
        projects={[{ id: 'proj-b', name: 'Project B', agents: [] }]}
        projectId="proj-b"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    expect(getByText(/Requires an agent with the/)).toBeTruthy();
  });

  it('pre-fills saved config and surfaces a save error via toast', async () => {
    const showToast = vi.fn();
    (api.updateProject as any).mockRejectedValue(new Error('nope'));
    const projects = [
      {
        id: 'proj-a',
        name: 'Project A',
        agents: [{ id: 'docs-1', role: 'docs', engine: 'claude-code' }],
        backgroundAgents: { wiki: { enabled: true, schedule: '0 9 * * *', limit: 7 } },
      },
    ];
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={projects}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={showToast}
      />,
    );
    expect((getByTestId('wiki-agent-enabled') as HTMLInputElement).checked).toBe(true);
    expect((getByTestId('wiki-agent-limit') as HTMLInputElement).value).toBe('7');

    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('nope', 'error'));
  });
});
