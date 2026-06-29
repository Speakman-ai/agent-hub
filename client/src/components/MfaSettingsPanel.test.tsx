import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
}));

vi.mock('../utils/api.js', () => ({
  api: {
    startMfaEnrollment: vi.fn(),
    confirmMfaEnrollment: vi.fn(),
    regenerateMfaRecoveryCodes: vi.fn(),
    disableMfa: vi.fn(),
  },
}));

import MfaSettingsPanel from './MfaSettingsPanel';
import { api } from '../utils/api';

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MfaSettingsPanel', () => {
  it('starts enrollment, renders QR/manual secret, confirms, and shows recovery codes once', async () => {
    (api.startMfaEnrollment as any).mockResolvedValue({
      ok: true,
      secret: 'SECRET123',
      otpauthUri: 'otpauth://totp/AgentHub:owner?secret=SECRET123',
      mfaEnabled: false,
    });
    (api.confirmMfaEnrollment as any).mockResolvedValue({
      ok: true,
      mfaEnabled: true,
      recoveryCodes: ['code-one', 'code-two'],
    });
    const onMfaChanged = vi.fn();

    render(<MfaSettingsPanel mfaEnabled={false} onMfaChanged={onMfaChanged} />);

    fireEvent.click(screen.getByRole('button', { name: /start enrollment/i }));

    expect(await screen.findByText('SECRET123')).toBeInTheDocument();
    expect(await screen.findByAltText(/MFA QR code/i)).toHaveAttribute(
      'src',
      'data:image/png;base64,qr',
    );

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('SECRET123');

    fireEvent.change(screen.getByLabelText(/Current code/i), { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm and enable/i }));

    await waitFor(() => expect(api.confirmMfaEnrollment).toHaveBeenCalledWith('123456'));
    expect(onMfaChanged).toHaveBeenCalledWith(true);
    expect(await screen.findByText('code-one')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /I saved these codes/i }));
    expect(screen.queryByText('code-one')).toBeNull();
  });

  it('regenerates recovery codes and disables MFA after a current second factor', async () => {
    (api.regenerateMfaRecoveryCodes as any).mockResolvedValue({
      ok: true,
      recoveryCodes: ['new-one'],
    });
    (api.disableMfa as any).mockResolvedValue({ ok: true, mfaEnabled: false });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onMfaChanged = vi.fn();

    render(<MfaSettingsPanel mfaEnabled onMfaChanged={onMfaChanged} />);

    fireEvent.change(screen.getByLabelText(/Authenticator or recovery code/i), {
      target: { value: '654 321' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Regenerate recovery codes/i }));

    await waitFor(() => expect(api.regenerateMfaRecoveryCodes).toHaveBeenCalledWith('654321'));
    expect(await screen.findByText('new-one')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Authenticator or recovery code/i), {
      target: { value: '111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Disable MFA/i }));

    await waitFor(() => expect(api.disableMfa).toHaveBeenCalledWith('111111'));
    expect(onMfaChanged).toHaveBeenCalledWith(false);
  });
});
