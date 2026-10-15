import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HubChatChannel } from '../utils/hubChat';

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn().mockResolvedValue([]),
    hubChat: {
      channel: vi.fn(),
      digest: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';
import { ChannelSettingsDialog, NewChannelDialog } from './HubChatDialogs';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

const GENERAL: HubChatChannel = {
  id: 'gen',
  orgId: 'acme',
  kind: 'channel',
  name: 'general',
  topic: null,
  isPrivate: false,
  projectId: null,
  agentId: null,
  dmPeerUserId: null,
  createdByUserId: 'alice',
  archivedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  lastSeq: 1,
  membership: { role: 'owner', lastReadSeq: 1, notifyLevel: 'all', mutedUntil: null },
  unreadCount: 0,
  mentionCount: 0,
};

beforeEach(() => {
  chat.channel!.mockResolvedValue({ channel: GENERAL, members: [] });
  chat.digest!.mockResolvedValue({ digest: null });
});

describe('Hub Chat dialog sizing', () => {
  it('renders the channel settings dialog at the wide size', async () => {
    render(
      <ChannelSettingsDialog
        channel={GENERAL}
        usernames={new Map()}
        orgMembers={[]}
        viewerUserId="alice"
        clock={() => 0}
        onClose={() => {}}
        onChanged={() => {}}
        onMembershipChanged={() => {}}
        onLeft={() => {}}
      />,
    );
    const dialog = screen.getByTestId('hub-chat-settings');
    expect(dialog.className).toContain('max-w-2xl');
    expect(dialog.className).toContain('max-h-[90vh]');
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).not.toContain('max-w-md');
    await screen.findByTestId('hub-chat-settings-members');
  });

  it('keeps other dialogs at the narrow size', () => {
    render(
      <NewChannelDialog
        members={[]}
        viewerUserId="alice"
        clock={() => 0}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const dialog = screen.getByTestId('hub-chat-new-channel');
    expect(dialog.className).toContain('max-w-md');
    expect(dialog.className).not.toContain('max-w-2xl');
  });
});
