import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-qrcode-svg', () => ({ default: 'QRCode' }));
vi.mock('../../utils/api', () => ({ api: {} }));
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }));

import { colors } from '../../theme/colors';
import { getMfaQrCodeProps, normalizeMfaCode } from './MfaSettingsSection';

describe('MfaSettingsSection helpers', () => {
  it('normalizes TOTP and recovery-code input before API submission', () => {
    expect(normalizeMfaCode(' 123 456 ')).toBe('123456');
    expect(normalizeMfaCode(' abcd efgh ')).toBe('abcdefgh');
    expect(normalizeMfaCode(null)).toBe('');
  });

  it('passes the otpauth URI to the native QR renderer instead of requiring a data URL', () => {
    expect(getMfaQrCodeProps('otpauth://totp/AgentHub:user@example.com')).toEqual({
      value: 'otpauth://totp/AgentHub:user@example.com',
      size: 220,
      backgroundColor: colors.white,
      color: colors.gray950,
    });
  });
});
