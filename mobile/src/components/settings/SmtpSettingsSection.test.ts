import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('../../utils/api', () => ({ api: {} }));

import {
  buildSmtpPatch,
  smtpFormFromSettings,
  smtpPasswordClearState,
  smtpStatusText,
} from './SmtpSettingsSection';

describe('SmtpSettingsSection helpers', () => {
  const configuredSettings = {
    smtp: {
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      tlsMode: 'ssl',
      username: 'mailer@example.com',
      passwordSet: true,
      configured: true,
      from: 'agenthub@example.com',
    },
  };

  it('hydrates the mobile form from masked SMTP settings', () => {
    expect(smtpStatusText(configuredSettings)).toBe('Configured');
    expect(smtpFormFromSettings(configuredSettings)).toEqual({
      enabled: true,
      host: 'smtp.example.com',
      port: '465',
      tlsMode: 'ssl',
      username: 'mailer@example.com',
      password: '',
      from: 'agenthub@example.com',
    });
  });

  it('preserves, clears, and replaces masked SMTP passwords in patches', () => {
    const form = smtpFormFromSettings(configuredSettings);
    expect(buildSmtpPatch(form, configuredSettings)).not.toHaveProperty('password');
    expect(buildSmtpPatch(form, configuredSettings, true)).toMatchObject({ password: null });
    expect(buildSmtpPatch({ ...form, password: 'new-secret' }, configuredSettings)).toMatchObject({
      password: 'new-secret',
    });
  });

  it('keeps the clear-password flag set when the mobile clear action blanks the field', () => {
    const next = smtpPasswordClearState({
      ...smtpFormFromSettings(configuredSettings),
      password: 'typed-secret',
    });

    expect(next.form.password).toBe('');
    expect(next.clearPassword).toBe(true);
    expect(buildSmtpPatch(next.form, configuredSettings, next.clearPassword)).toMatchObject({
      password: null,
    });
  });

  it('sends password:null when no stored password exists and the field is blank', () => {
    const settings = { smtp: { ...configuredSettings.smtp, passwordSet: false } };
    expect(buildSmtpPatch(smtpFormFromSettings(settings), settings)).toMatchObject({
      password: null,
    });
    expect(smtpStatusText({ smtp: { configured: false } })).toBe('Not configured');
  });
});
