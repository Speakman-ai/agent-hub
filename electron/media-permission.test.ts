import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePermissionRequest, type MediaAccessDeps } from './media-permission.js';

function deps(over: Partial<MediaAccessDeps> = {}): MediaAccessDeps {
  return {
    platform: 'darwin',
    getMediaAccessStatus: vi.fn(() => 'not-determined'),
    askForMediaAccess: vi.fn(async () => true),
    ...over,
  };
}

describe('resolvePermissionRequest', () => {
  it('keeps granting non-media permissions', async () => {
    const d = deps();
    expect(await resolvePermissionRequest('notifications', {}, d)).toBe(true);
    expect(d.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('does not involve macOS privacy APIs on other platforms', async () => {
    const d = deps({ platform: 'win32' });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio'] }, d)).toBe(true);
    expect(d.getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it('shows the macOS microphone prompt the first time and follows the answer', async () => {
    const d = deps({ askForMediaAccess: vi.fn(async () => false) });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio'] }, d)).toBe(false);
    expect(d.askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('regression: denies instead of handing the renderer a silent stream when mic access is off', async () => {
    const d = deps({ getMediaAccessStatus: vi.fn(() => 'denied') });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio'] }, d)).toBe(false);
    expect(d.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('grants without prompting once access is granted', async () => {
    const d = deps({ getMediaAccessStatus: vi.fn(() => 'granted') });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio'] }, d)).toBe(true);
    expect(d.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('treats a media request without mediaTypes as a microphone request', async () => {
    const d = deps();
    await resolvePermissionRequest('media', {}, d);
    expect(d.askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('checks the camera too when video is requested', async () => {
    const d = deps({
      getMediaAccessStatus: vi.fn((t) => (t === 'microphone' ? 'granted' : 'denied')),
    });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio', 'video'] }, d)).toBe(
      false,
    );
  });

  it('fails closed when the system prompt throws', async () => {
    const d = deps({ askForMediaAccess: vi.fn(async () => Promise.reject(new Error('boom'))) });
    expect(await resolvePermissionRequest('media', { mediaTypes: ['audio'] }, d)).toBe(false);
  });
});

describe('packaged macOS build', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const mac = pkg.build.mac;

  it('declares why it uses the microphone (TCC silences the mic without it)', () => {
    expect(mac.extendInfo?.NSMicrophoneUsageDescription).toMatch(/\S/);
  });

  it('carries the audio-input entitlement for hardened-runtime builds', () => {
    for (const key of ['entitlements', 'entitlementsInherit']) {
      const plist = readFileSync(path.join(ROOT, mac[key]), 'utf8');
      expect(plist).toContain('<key>com.apple.security.device.audio-input</key>');
      expect(plist).toContain('<key>com.apple.security.cs.allow-jit</key>');
    }
  });
});
