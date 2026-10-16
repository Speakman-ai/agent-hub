import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    getSkills: vi.fn(),
    hubChat: {
      digests: vi.fn(),
      createDigest: vi.fn(),
      updateDigest: vi.fn(),
      removeDigest: vi.fn(),
      runDigest: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';
import { HubChatDigestSection } from './HubChatDigestSection';

const hubChat = api.hubChat as unknown as Record<string, ReturnType<typeof vi.fn>>;
const getProjects = api.getProjects as unknown as ReturnType<typeof vi.fn>;
const getSkills = api.getSkills as unknown as ReturnType<typeof vi.fn>;

const PROMPT = 'Go through the server logs in the last 24 hours and show me any of concern.';

const saved = {
  id: 'd1',
  channelId: 'c1',
  name: 'Log Summary',
  enabled: true,
  cron: '0 17 * * *',
  timeZone: 'UTC',
  scope: 'agent',
  projectIds: ['web'],
  prompt: PROMPT,
  agentId: 'web-dev',
  skills: ['support-logs'],
  ownerUserId: 'u1',
  windowStart: '2026-10-13T17:00:00.000Z',
  lastRunAt: '2026-10-14T17:00:00.000Z',
  lastStatus: 'started',
  lastError: null,
  lastMessageId: null,
  createdAt: 'x',
  updatedAt: 'x',
};

const builtIn = {
  ...saved,
  id: 'd2',
  name: 'Project digest',
  scope: 'project',
  projectIds: ['web', 'api'],
  prompt: null,
  agentId: null,
  skills: [],
  lastStatus: 'skipped',
};

beforeEach(() => {
  vi.clearAllMocks();
  getProjects.mockResolvedValue([
    {
      id: 'web',
      name: 'Web',
      agents: [
        { id: 'web-dev', name: 'Web Dev' },
        { id: 'web-ops', name: 'Web Ops', allowedSkills: ['support-logs'] },
        { id: 'web-reviewer', name: 'Web Reviewer', role: 'reviewer' },
      ],
    },
    { id: 'api', name: 'API', agents: [{ id: 'api-dev', name: 'API Dev' }] },
  ]);
  getSkills.mockResolvedValue([
    { id: 'support-logs', description: 'Read support > logs' },
    { id: 'agent-hub-kanban' },
  ]);
});

const renderSection = (projectId: string | null = null) =>
  render(<HubChatDigestSection channelId="c1" channelProjectId={projectId} />);

describe('HubChatDigestSection', () => {
  it('has no summarize selector: a new digest is project, agent, skills and prompt', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [] });
    hubChat.createDigest!.mockResolvedValue({ digest: saved });
    renderSection('web');

    fireEvent.click(await screen.findByRole('button', { name: /Add digest/ }));
    expect(screen.queryByLabelText('Digest scope')).toBeNull();
    const save = screen.getByRole('button', { name: 'Schedule digest' });

    await waitFor(() => expect(screen.getByLabelText('Digest project')).toHaveValue('web'));
    const agent = screen.getByLabelText('Digest agent');
    // Reviewers cannot run a digest session.
    expect(within(agent).queryByRole('option', { name: 'Web Reviewer' })).toBeNull();
    fireEvent.change(agent, { target: { value: 'web-dev' } });
    expect(save).toBeDisabled();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Skill support-logs' }));
    fireEvent.change(screen.getByLabelText('Digest name'), { target: { value: 'Log Summary' } });
    fireEvent.change(screen.getByLabelText('Digest timezone'), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByLabelText('Digest prompt'), { target: { value: PROMPT } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(hubChat.createDigest).toHaveBeenCalledWith('c1', {
        name: 'Log Summary',
        enabled: true,
        cron: '0 9 * * 1-5',
        timeZone: 'UTC',
        scope: 'agent',
        projectIds: ['web'],
        agentId: 'web-dev',
        skills: ['support-logs'],
        prompt: PROMPT,
      }),
    );
    expect(await screen.findByTestId('hub-chat-digest-d1')).toBeInTheDocument();
  });

  it("offers only the skills the chosen agent's allowlist permits", async () => {
    hubChat.digests!.mockResolvedValue({ digests: [] });
    renderSection('web');
    fireEvent.click(await screen.findByRole('button', { name: /Add digest/ }));
    await waitFor(() => expect(screen.getByLabelText('Digest project')).toHaveValue('web'));
    fireEvent.change(screen.getByLabelText('Digest agent'), { target: { value: 'web-ops' } });
    expect(await screen.findByRole('checkbox', { name: 'Skill support-logs' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Skill agent-hub-kanban' })).toBeNull();
    expect(getSkills).toHaveBeenCalledWith('web-ops');
  });

  it('changing the project clears the agent and skills', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    renderSection();
    fireEvent.click(await screen.findByText('Log Summary'));
    await waitFor(() => expect(screen.getByLabelText('Digest agent')).toHaveValue('web-dev'));
    expect(await screen.findByRole('checkbox', { name: 'Skill support-logs' })).toBeChecked();

    fireEvent.change(screen.getByLabelText('Digest project'), { target: { value: 'api' } });
    expect(screen.getByLabelText('Digest agent')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save digest' })).toBeDisabled();
  });

  it('keeps a built-in digest as is until an agent is picked', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [builtIn] });
    hubChat.updateDigest!.mockResolvedValue({ digest: { ...builtIn, enabled: false } });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    expect(screen.getByTestId('hub-chat-digest-builtin')).toHaveTextContent(/Built-in summary/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd2',
        expect.objectContaining({ scope: 'project', projectIds: ['web', 'api'], enabled: false }),
      ),
    );
  });

  it('converts a built-in digest to an agent digest once a project and agent are picked', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [builtIn] });
    hubChat.updateDigest!.mockResolvedValue({ digest: saved });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    await waitFor(() => expect(screen.getByLabelText('Digest project')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Digest project'), { target: { value: 'web' } });
    fireEvent.change(screen.getByLabelText('Digest agent'), { target: { value: 'web-dev' } });
    expect(screen.queryByTestId('hub-chat-digest-builtin')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save digest' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Digest prompt'), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd2',
        expect.objectContaining({
          scope: 'agent',
          projectIds: ['web'],
          agentId: 'web-dev',
          prompt: PROMPT,
        }),
      ),
    );
  });

  it('runs an agent digest now and says the reply will follow', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.runDigest!.mockResolvedValue({
      result: { status: 'started', sessionId: 's1', skippedSkills: [] },
      digest: saved,
    });
    renderSection();

    fireEvent.click(await screen.findByText('Log Summary'));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Started the agent/)).toBeInTheDocument();
    expect(hubChat.runDigest).toHaveBeenCalledWith('c1', 'd1');
    expect(screen.getByTestId('hub-chat-digest-status')).toHaveTextContent(/started the agent/);
  });

  it('renders a failed save inline on that digest only', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved, builtIn] });
    hubChat.updateDigest!.mockRejectedValue(new Error('Invalid cron expression'));
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    const card = screen.getByTestId('hub-chat-digest-d2');
    expect(await within(card).findByRole('alert')).toHaveTextContent('Invalid cron expression');
    expect(within(screen.getByTestId('hub-chat-digest-d1')).queryByRole('alert')).toBeNull();
  });

  it('removes a digest by id', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.removeDigest!.mockResolvedValue({ ok: true });
    renderSection();

    fireEvent.click(await screen.findByText('Log Summary'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('No digests scheduled.');
    expect(hubChat.removeDigest).toHaveBeenCalledWith('c1', 'd1');
  });

  it('disables Add digest at the per-channel cap', async () => {
    hubChat.digests!.mockResolvedValue({
      digests: Array.from({ length: 10 }, (_, i) => ({ ...saved, id: `d${i}` })),
    });
    renderSection();
    expect(await screen.findByRole('button', { name: /Add digest/ })).toBeDisabled();
  });
});
