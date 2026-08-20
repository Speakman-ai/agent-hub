import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import BackgroundAgentsSection from './BackgroundAgentsSection';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';

/**
 * Project Settings → AI → Background Agents (Wiki agent).
 *
 * Pins the vertical slice: the section renders the Wiki agent with defaults
 * even when the project has no `backgroundAgents` config, sources "Runs as
 * user" from the org roster (defaulting to the logged-in user), requires an
 * explicit model before enabling, and saves the config through
 * `PATCH /api/projects/:id`.
 */

vi.mock('../utils/api', () => ({
  api: {
    getOrgUsers: vi.fn(),
    getModelConfig: vi.fn(),
    updateProject: vi.fn(),
  },
}));

vi.mock('../utils/auth', () => ({
  getAuthRecord: vi.fn(),
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
  (getAuthRecord as any).mockReturnValue({ user: { id: 'me-1', username: 'ryan' } });
  (api.getOrgUsers as any).mockResolvedValue({
    users: [
      { id: 'me-1', username: 'ryan', role: 'Owner' },
      { id: 'u2', username: 'sam', role: 'User' },
    ],
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
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());

    const toggle = getByTestId('wiki-agent-enabled') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.checked).toBe(true);

    // A model must be picked explicitly before the enabled agent can save.
    await act(async () => {
      fireEvent.change(getByTestId('wiki-agent-model'), {
        target: { value: 'claude-opus-4-8' },
      });
    });

    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    const [pid, body] = (api.updateProject as any).mock.calls[0];
    expect(pid).toBe('proj-a');
    expect(body.backgroundAgents.wiki.enabled).toBe(true);
    expect(body.backgroundAgents.wiki.schedule).toBe('0 3 * * *');
    expect(body.backgroundAgents.wiki.model).toBe('claude-opus-4-8');
    // Defaulted to the logged-in user, not the userless fallback.
    expect(body.backgroundAgents.wiki.ownerUserId).toBe('me-1');
    expect(onProjectsChange).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Background agents saved', 'success');
  });

  it('defaults "Runs as user" to the logged-in user and lists org users', async () => {
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());
    const owner = getByTestId('wiki-agent-owner') as HTMLSelectElement;
    // Defaults to the logged-in user id.
    await waitFor(() => expect(owner.value).toBe('me-1'));
    const values = Array.from(owner.options).map((o) => o.value);
    expect(values).toContain('');
    expect(values).toContain('me-1');
    expect(values).toContain('u2');
  });

  it('still lists the logged-in user when the org roster fetch is forbidden', async () => {
    (api.getOrgUsers as any).mockRejectedValue(new Error('403'));
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());
    const owner = getByTestId('wiki-agent-owner') as HTMLSelectElement;
    await waitFor(() => expect(owner.value).toBe('me-1'));
    const values = Array.from(owner.options).map((o) => o.value);
    expect(values).toContain('me-1');
  });

  it('blocks enabling the agent without an explicit model', async () => {
    const showToast = vi.fn();
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={showToast}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-enabled'));
    });
    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'Pick a model for the Wiki agent before enabling it',
      'error',
    );
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
        backgroundAgents: {
          wiki: {
            enabled: true,
            schedule: '0 9 * * *',
            limit: 7,
            model: 'claude-sonnet-4-5',
          },
        },
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

  it('adds a custom agent with an editable prompt and saves it', async () => {
    const { getByTestId, queryByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());

    // Empty state until one is added.
    expect(queryByTestId('custom-agents-empty')).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByTestId('add-custom-agent'));
    });
    expect(getByTestId('custom-agent')).toBeTruthy();

    await act(async () => {
      fireEvent.change(getByTestId('custom-agent-name-0'), {
        target: { value: 'Nightly digest' },
      });
      fireEvent.change(getByTestId('custom-agent-prompt-0'), {
        target: { value: 'Summarize open PRs' },
      });
      fireEvent.click(getByTestId('custom-agent-enabled-0'));
    });

    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    const [, body] = (api.updateProject as any).mock.calls[0];
    expect(body.backgroundAgents.custom).toHaveLength(1);
    expect(body.backgroundAgents.custom[0]).toMatchObject({
      name: 'Nightly digest',
      prompt: 'Summarize open PRs',
      enabled: true,
      ownerUserId: 'me-1',
    });
    expect(typeof body.backgroundAgents.custom[0].id).toBe('string');
  });

  it('blocks saving a custom agent with a blank prompt', async () => {
    const showToast = vi.fn();
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={showToast}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(getByTestId('add-custom-agent'));
    });
    await act(async () => {
      fireEvent.change(getByTestId('custom-agent-name-0'), { target: { value: 'Named' } });
    });
    await act(async () => {
      fireEvent.click(getByTestId('wiki-agent-save'));
    });

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Add a prompt/), 'error');
  });

  it('removes a custom agent', async () => {
    const { getByTestId, queryByTestId } = render(
      <BackgroundAgentsSection
        projects={PROJECTS}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(getByTestId('add-custom-agent'));
    });
    expect(queryByTestId('custom-agent')).toBeTruthy();
    await act(async () => {
      fireEvent.click(getByTestId('custom-agent-remove-0'));
    });
    expect(queryByTestId('custom-agent')).toBeNull();
  });

  it('pre-fills saved custom agents from project config', async () => {
    const projects = [
      {
        id: 'proj-a',
        name: 'Project A',
        agents: [{ id: 'docs-1', role: 'docs', engine: 'claude-code' }],
        backgroundAgents: {
          custom: [
            { id: 'c1', name: 'Existing', enabled: true, prompt: 'run this', ownerUserId: 'u2' },
          ],
        },
      },
    ];
    const { getByTestId } = render(
      <BackgroundAgentsSection
        projects={projects}
        projectId="proj-a"
        onProjectsChange={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.getOrgUsers).toHaveBeenCalled());
    expect((getByTestId('custom-agent-name-0') as HTMLInputElement).value).toBe('Existing');
    expect((getByTestId('custom-agent-prompt-0') as HTMLTextAreaElement).value).toBe('run this');
    expect((getByTestId('custom-agent-enabled-0') as HTMLInputElement).checked).toBe(true);
  });
});
