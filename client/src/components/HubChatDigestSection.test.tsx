import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    hubChat: { digest: vi.fn(), saveDigest: vi.fn(), removeDigest: vi.fn() },
  },
}));

import { api } from '../utils/api';
import { HubChatDigestSection } from './HubChatDigestSection';

const hubChat = api.hubChat as unknown as Record<string, ReturnType<typeof vi.fn>>;
const getProjects = api.getProjects as unknown as ReturnType<typeof vi.fn>;

const saved = {
  channelId: 'c1',
  enabled: true,
  cron: '0 17 * * *',
  timeZone: 'UTC',
  scope: 'project',
  projectId: 'web',
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
    hubChat.digest!.mockResolvedValue({ digest: null });
    hubChat.saveDigest!.mockResolvedValue({ digest: saved });
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
      expect(hubChat.saveDigest).toHaveBeenCalledWith('c1', {
        enabled: true,
        cron: '0 17 * * *',
        timeZone: 'UTC',
        scope: 'project',
        projectId: 'web',
      }),
    );
    expect(await screen.findByText(/nothing new, skipped posting/)).toBeInTheDocument();
  });

  it('removes an existing digest', async () => {
    hubChat.digest!.mockResolvedValue({ digest: saved });
    hubChat.removeDigest!.mockResolvedValue({ digest: null });
    render(<HubChatDigestSection channelId="c1" channelProjectId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('No digest scheduled.');
    expect(hubChat.removeDigest).toHaveBeenCalledWith('c1');
  });
});
