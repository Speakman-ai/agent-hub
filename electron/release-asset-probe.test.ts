import { describe, it, expect, vi } from 'vitest';
import { isProbeableInstallerUrl, probeInstallerUrl } from './release-asset-probe.js';

const DMG =
  'https://agent-hub-prod-releases.s3.us-east-2.amazonaws.com/v2.31.185/Agent%20Hub-2.31.185-arm64.dmg';

describe('isProbeableInstallerUrl', () => {
  it('accepts versioned DMG keys on public S3 endpoints', () => {
    expect(isProbeableInstallerUrl(DMG)).not.toBeNull();
    expect(
      isProbeableInstallerUrl('https://bucket.s3.amazonaws.com/v1.2.3/Agent%20Hub-1.2.3.dmg'),
    ).not.toBeNull();
  });

  it('rejects unrelated hosts, private targets, and non-installer paths', () => {
    for (const bad of [
      'https://example.test/probe.dmg',
      'https://example.test/v1.2.3/probe.dmg',
      'https://127.0.0.1/v1.2.3/x.dmg',
      'https://localhost/v1.2.3/x.dmg',
      'https://169.254.169.254/v1.2.3/x.dmg',
      'https://bucket.s3.amazonaws.com.evil.test/v1.2.3/x.dmg',
      'http://bucket.s3.amazonaws.com/v1.2.3/x.dmg',
      'https://bucket.s3.amazonaws.com:8443/v1.2.3/x.dmg',
      'https://user:pw@bucket.s3.amazonaws.com/v1.2.3/x.dmg',
      'https://bucket.s3.amazonaws.com/v1.2.3/x.dmg?redirect=1',
      'https://bucket.s3.amazonaws.com/api/health',
      'https://bucket.s3.amazonaws.com/x.dmg',
      'not a url',
      42,
    ]) {
      expect(isProbeableInstallerUrl(bad)).toBeNull();
    }
  });
});

describe('probeInstallerUrl', () => {
  it('treats the S3 403 for an unpublished DMG as missing', async () => {
    // Regression: the update popup linked a DMG that was not uploaded yet and
    // the user landed on an S3 AccessDenied XML page.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(probeInstallerUrl(DMG, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      DMG,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  it('reports a published DMG as available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(probeInstallerUrl(DMG, fetchImpl)).resolves.toBe(true);
  });

  it('does not follow redirects, including to http or private destinations', async () => {
    for (const location of ['http://127.0.0.1:3051/api/health', 'https://10.0.0.5/x.dmg']) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      await expect(probeInstallerUrl(DMG, fetchImpl)).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('returns false on network errors', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(probeInstallerUrl(DMG, failing)).resolves.toBe(false);
  });

  it('returns null without fetching for URLs outside the S3 allowlist', async () => {
    const unused = vi.fn();
    await expect(probeInstallerUrl('https://example.test/probe.dmg', unused)).resolves.toBeNull();
    await expect(
      probeInstallerUrl('https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0.dmg', unused),
    ).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});
