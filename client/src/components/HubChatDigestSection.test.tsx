import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DEFAULT_CHAT_DIGEST_INSTRUCTIONS } from '@shared/utils/chatDigest';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
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

const saved = {
  id: 'd1',
  channelId: 'c1',
  name: 'Project digest',
  enabled: true,
  cron: '0 17 * * *',
  timeZone: 'UTC',
  scope: 'project',
  projectIds: ['web'],
  prompt: null,
  ownerUserId: 'u1',
  windowStart: '2026-10-13T17:00:00.000Z',
  lastRunAt: '2026-10-14T17:00:00.000Z',
  lastStatus: 'skipped',
  lastError: null,
  lastMessageId: null,
  createdAt: 'x',
  updatedAt: 'x',
};

beforeEach(() => {
  vi.clearAllMocks();
  getProjects.mockResolvedValue([
    { id: 'web', name: 'Web' },
    { id: 'api', name: 'API' },
  ]);
});

const renderSection = () => render(<HubChatDigestSection channelId="c1" channelProjectId={null} />);

describe('HubChatDigestSection', () => {
  it('lists every digest with its name, schedule, and status', async () => {
    hubChat.digests!.mockResolvedValue({
      digests: [saved, { ...saved, id: 'd2', name: 'Standup', scope: 'channel', projectIds: [] }],
    });
    renderSection();

    expect(await screen.findByText('Project digest')).toBeInTheDocument();
    expect(screen.getByText('Standup')).toBeInTheDocument();
    expect(screen.getAllByTestId('hub-chat-digest-status')[0]).toHaveTextContent(
      /nothing new, skipped posting/,
    );
  });

  it('adds a second digest next to an existing one', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.createDigest!.mockResolvedValue({
      digest: { ...saved, id: 'd2', name: 'Standup', scope: 'channel', projectIds: [] },
    });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: /Add digest/ }));
    fireEvent.change(screen.getByLabelText('Digest name'), { target: { value: 'Standup' } });
    fireEvent.change(screen.getByLabelText('Digest timezone'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule digest' }));

    await waitFor(() =>
      expect(hubChat.createDigest).toHaveBeenCalledWith('c1', {
        name: 'Standup',
        enabled: true,
        cron: '0 9 * * 1-5',
        timeZone: 'UTC',
        scope: 'channel',
        projectIds: [],
        prompt: null,
      }),
    );
    expect(await screen.findByTestId('hub-chat-digest-d2')).toBeInTheDocument();
    expect(screen.getByTestId('hub-chat-digest-d1')).toBeInTheDocument();
    expect(hubChat.updateDigest).not.toHaveBeenCalled();
  });

  it('saves a digest covering several projects', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.updateDigest!.mockResolvedValue({ digest: { ...saved, projectIds: ['web', 'api'] } });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'API' }));
    expect(screen.getByRole('checkbox', { name: 'Web' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd1',
        expect.objectContaining({
          name: 'Project digest',
          scope: 'project',
          projectIds: ['web', 'api'],
        }),
      ),
    );
  });

  it('saves a custom prompt and shows the default instructions as placeholder', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.updateDigest!.mockResolvedValue({ digest: { ...saved, prompt: 'Only list risks.' } });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    const prompt = screen.getByLabelText('Digest instructions');
    expect(prompt).toHaveAttribute('placeholder', DEFAULT_CHAT_DIGEST_INSTRUCTIONS);
    fireEvent.change(prompt, { target: { value: '  Only list risks.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));

    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd1',
        expect.objectContaining({ prompt: 'Only list risks.' }),
      ),
    );
  });

  it('sends null to restore the default prompt when cleared', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [{ ...saved, prompt: 'Old' }] });
    hubChat.updateDigest!.mockResolvedValue({ digest: saved });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    fireEvent.change(screen.getByLabelText('Digest instructions'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd1',
        expect.objectContaining({ prompt: null }),
      ),
    );
  });

  it('runs a digest now and shows the outcome', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.runDigest!.mockResolvedValue({
      result: { status: 'posted', messageId: 'm1' },
      digest: { ...saved, lastStatus: 'posted' },
    });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Posted a digest.')).toBeInTheDocument();
    expect(hubChat.runDigest).toHaveBeenCalledWith('c1', 'd1');
    expect(screen.getByTestId('hub-chat-digest-status')).toHaveTextContent(/posted a digest/);
  });

  it('renders a failed save inline on that digest only', async () => {
    hubChat.digests!.mockResolvedValue({
      digests: [saved, { ...saved, id: 'd2', name: 'Standup', scope: 'channel', projectIds: [] }],
    });
    hubChat.updateDigest!.mockRejectedValue(new Error('Invalid cron expression'));
    renderSection();

    fireEvent.click(await screen.findByText('Standup'));
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    const card = screen.getByTestId('hub-chat-digest-d2');
    expect(await within(card).findByRole('alert')).toHaveTextContent('Invalid cron expression');
    expect(within(screen.getByTestId('hub-chat-digest-d1')).queryByRole('alert')).toBeNull();
  });

  it('removes a digest by id', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.removeDigest!.mockResolvedValue({ ok: true });
    renderSection();

    fireEvent.click(await screen.findByText('Project digest'));
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
