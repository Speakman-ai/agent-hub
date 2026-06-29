import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('../../utils/api', () => ({ api: {} }));
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../../utils/config', () => ({ getServerBaseUrl: vi.fn(() => 'https://hub.test') }));

import {
  absoluteInviteUrl,
  copyMemberInvite,
  createInviteAndCopyLink,
  inviteRoleOptionsFor,
  isValidInviteEmail,
  loadMemberInvites,
  revokeMemberInvite,
} from './MembersSection';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MembersSection invite helpers', () => {
  it('gates invite roles to Owner/Admin callers and validates invite emails', () => {
    expect(inviteRoleOptionsFor('Owner')).toEqual(['Admin', 'User']);
    expect(inviteRoleOptionsFor('Admin')).toEqual(['Admin', 'User']);
    expect(inviteRoleOptionsFor('User')).toEqual([]);
    expect(isValidInviteEmail('new@example.com')).toBe(true);
    expect(isValidInviteEmail('not-email')).toBe(false);
  });

  it('loads invites only for Owner/Admin callers', async () => {
    const adminApi = {
      getMe: vi.fn().mockResolvedValue({ user: { role: 'Admin' } }),
      getInvites: vi.fn().mockResolvedValue({ invites: [{ token: 'tok-1' }] }),
    };
    await expect(loadMemberInvites(adminApi)).resolves.toEqual({
      me: { role: 'Admin' },
      invites: [{ token: 'tok-1' }],
    });
    expect(adminApi.getInvites).toHaveBeenCalledTimes(1);

    const userApi = {
      getMe: vi.fn().mockResolvedValue({ user: { role: 'User' } }),
      getInvites: vi.fn(),
    };
    await expect(loadMemberInvites(userApi)).resolves.toEqual({
      me: { role: 'User' },
      invites: [],
    });
    expect(userApi.getInvites).not.toHaveBeenCalled();
  });

  it('constructs absolute invite links from server-relative rows', () => {
    expect(absoluteInviteUrl({ token: 'tok-1' })).toBe('https://hub.test/invite/tok-1');
    expect(absoluteInviteUrl({ url: '/invite/tok-2' })).toBe('https://hub.test/invite/tok-2');
    expect(absoluteInviteUrl({ url: 'https://other.test/invite/tok-3' })).toBe(
      'https://other.test/invite/tok-3',
    );
  });

  it('creates an invite and copies the generated link', async () => {
    const apiClient = {
      createInvite: vi.fn().mockResolvedValue({
        token: 'tok-created',
        url: '/invite/tok-created',
        email: 'created@example.com',
        role: 'User',
      }),
    };
    const clipboard = vi.fn().mockResolvedValue(true);

    await expect(
      createInviteAndCopyLink({
        apiClient,
        clipboard,
        email: ' created@example.com ',
        role: 'User',
      }),
    ).resolves.toMatchObject({
      ok: true,
      copied: true,
      status: { type: 'success', message: 'Invite created and link copied.' },
    });
    expect(apiClient.createInvite).toHaveBeenCalledWith({
      email: 'created@example.com',
      role: 'User',
    });
    expect(clipboard).toHaveBeenCalledWith('https://hub.test/invite/tok-created');
  });

  it('returns validation status instead of creating when email is invalid', async () => {
    const apiClient = { createInvite: vi.fn() };
    const clipboard = vi.fn();

    await expect(
      createInviteAndCopyLink({ apiClient, clipboard, email: 'bad', role: 'User' }),
    ).resolves.toEqual({
      ok: false,
      status: { type: 'error', message: 'Enter a valid email address.' },
    });
    expect(apiClient.createInvite).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('copies and revokes active invites', async () => {
    const invite = { token: 'tok-1', email: 'new@example.com' };
    const clipboard = vi.fn().mockResolvedValue(true);
    await expect(copyMemberInvite({ clipboard, invite })).resolves.toEqual({
      copied: true,
      status: { type: 'success', message: 'Invite link copied.' },
    });
    expect(clipboard).toHaveBeenCalledWith('https://hub.test/invite/tok-1');

    const apiClient = { revokeInvite: vi.fn().mockResolvedValue({ ok: true }) };
    await expect(revokeMemberInvite({ apiClient, invite })).resolves.toEqual({
      type: 'success',
      message: 'Invite revoked.',
    });
    expect(apiClient.revokeInvite).toHaveBeenCalledWith('tok-1');
  });
});
