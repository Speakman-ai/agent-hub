import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    hubChat: {
      digests: vi.fn(),
      createDigest: vi.fn(),
      updateDigest: vi.fn(),
      removeDigest: vi.fn(),
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

describe('HubChatDigestSection', () => {
  it('schedules a project digest with the chosen preset', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [] });
    hubChat.createDigest!.mockResolvedValue({ digest: saved });
    render(<HubChatDigestSection channelId="c1" channelProjectId={null} />);

    await screen.findByText('No digest scheduled.');
    fireEvent.change(screen.getByLabelText('Digest scope'), { target: { value: 'project' } });
    await waitFor(() => expect(screen.getByLabelText('Digest project')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Digest project'), { target: { value: 'web' } });
    fireEvent.change(screen.getByLabelText('Digest schedule preset'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Digest timezone'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule digest' }));

    await waitFor(() =>
      expect(hubChat.createDigest).toHaveBeenCalledWith('c1', {
        name: undefined,
        enabled: true,
        cron: '0 17 * * *',
        timeZone: 'UTC',
        scope: 'project',
        projectIds: ['web'],
      }),
    );
    expect(await screen.findByText(/nothing new, skipped posting/)).toBeInTheDocument();
  });

  it('edits the existing digest by id, keeping its name', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.updateDigest!.mockResolvedValue({ digest: { ...saved, cron: '0 9 * * 1' } });
    render(<HubChatDigestSection channelId="c1" channelProjectId={null} />);

    await screen.findByRole('button', { name: 'Save digest' });
    fireEvent.change(screen.getByLabelText('Digest schedule preset'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save digest' }));
    await waitFor(() =>
      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd1',
        expect.objectContaining({ name: 'Project digest', cron: '0 9 * * 1', projectIds: ['web'] }),
      ),
    );
    expect(hubChat.createDigest).not.toHaveBeenCalled();
  });

  it('removes an existing digest by id', async () => {
    hubChat.digests!.mockResolvedValue({ digests: [saved] });
    hubChat.removeDigest!.mockResolvedValue({ ok: true });
    render(<HubChatDigestSection channelId="c1" channelProjectId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('No digest scheduled.');
    expect(hubChat.removeDigest).toHaveBeenCalledWith('c1', 'd1');
  });
});
