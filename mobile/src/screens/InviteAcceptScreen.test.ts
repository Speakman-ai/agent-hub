import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  SafeAreaView: 'SafeAreaView',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../utils/auth', () => ({ setToken: vi.fn() }));

import {
  acceptInviteAndEnterApp,
  buildAcceptInviteBody,
  inviteStateMessage,
  isValidInviteEmail,
} from './InviteAcceptScreen';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InviteAcceptScreen flow helpers', () => {
  it('validates email and builds the accept body used by the screen', () => {
    expect(isValidInviteEmail('new@example.com')).toBe(true);
    expect(isValidInviteEmail('not-email')).toBe(false);
    expect(buildAcceptInviteBody('  new@example.com  ', 'correct-password')).toEqual({
      email: 'new@example.com',
      username: 'new@example.com',
      password: 'correct-password',
    });
  });

  it('maps accepted and expired invite API errors to mobile copy', () => {
    expect(inviteStateMessage(new Error('410: invite expired'))).toBe(
      'This invite has expired or was already used.',
    );
    expect(inviteStateMessage(new Error('404: invite not found'))).toBe(
      'This invite link was not found.',
    );
    expect(inviteStateMessage('This invite has already been accepted.')).toBe(
      'This invite has already been accepted.',
    );
  });

  it('accepts an invite, persists the token, and calls onAccepted when supplied', async () => {
    const acceptInvite = vi.fn().mockResolvedValue({
      token: 'jwt',
      expiresAt: '2026-07-01T00:00:00.000Z',
      user: { email: 'new@example.com', role: 'User' },
    });
    const persistToken = vi.fn().mockResolvedValue(undefined);
    const onAccepted = vi.fn();
    const navigation = { reset: vi.fn() };

    const result = await acceptInviteAndEnterApp({
      token: 'tok-1',
      email: 'new@example.com',
      password: 'correct-password',
      acceptInvite,
      persistToken,
      onAccepted,
      navigation,
    });

    expect(acceptInvite).toHaveBeenCalledWith('tok-1', {
      email: 'new@example.com',
      username: 'new@example.com',
      password: 'correct-password',
    });
    expect(persistToken).toHaveBeenCalledWith(result);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(navigation.reset).not.toHaveBeenCalled();
  });

  it('resets to Dashboard after acceptance when onAccepted is absent', async () => {
    const acceptInvite = vi.fn().mockResolvedValue({ token: 'jwt' });
    const persistToken = vi.fn().mockResolvedValue(undefined);
    const navigation = { reset: vi.fn() };

    await acceptInviteAndEnterApp({
      token: 'tok-1',
      email: 'admin@example.com',
      password: 'correct-password',
      acceptInvite,
      persistToken,
      navigation,
    });

    expect(persistToken).toHaveBeenCalledWith({ token: 'jwt' });
    expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Hub' }] });
  });
});
