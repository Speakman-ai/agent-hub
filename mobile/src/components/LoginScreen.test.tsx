import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('../utils/auth', () => ({
  completeMfaLogin: vi.fn(),
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  needsEmailUpdate: vi.fn(),
  setup: vi.fn(),
  updateEmail: vi.fn(),
}));
vi.mock('../utils/config', () => ({ getApiBaseUrl: vi.fn(() => '/api') }));

import { getPostAuthenticationMode } from './LoginScreen';

describe('LoginScreen helpers', () => {
  it('routes post-MFA authentication through forced email migration when required', () => {
    expect(getPostAuthenticationMode({ needsEmailUpdateValue: true })).toBe('email-update');
  });

  it('authenticates after MFA when no email migration is required', () => {
    expect(getPostAuthenticationMode({ needsEmailUpdateValue: false })).toBe('authenticated');
  });
});
