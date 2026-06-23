import { describe, it, expect } from 'vitest';
import {
  isPreviewMode,
  buildPreviewServerConfig,
  resolvePreviewAllowedHosts,
  resolvePreviewUpstreamAllowedHost,
} from './previewServerConfig';

describe('isPreviewMode', () => {
  it('is false when AGENT_HUB_PREVIEW is unset', () => {
    expect(isPreviewMode({})).toBe(false);
    expect(isPreviewMode({ FRONTEND_PORT: '80' })).toBe(false);
  });

  it('is true only when AGENT_HUB_PREVIEW === "1"', () => {
    expect(isPreviewMode({ AGENT_HUB_PREVIEW: '1' })).toBe(true);
    expect(isPreviewMode({ AGENT_HUB_PREVIEW: 'true' })).toBe(false);
    expect(isPreviewMode({ AGENT_HUB_PREVIEW: '0' })).toBe(false);
  });
});

describe('buildPreviewServerConfig', () => {
  it('returns null outside preview mode (normal dev/build untouched)', () => {
    expect(buildPreviewServerConfig({})).toBeNull();
    expect(buildPreviewServerConfig({ FRONTEND_PORT: '80', VITE_API_PORT: '3051' })).toBeNull();
  });

  it('builds an HMR-over-proxy server config in preview mode', () => {
    const cfg = buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' });
    expect(cfg!).toMatchObject({
      host: '0.0.0.0',
      port: 80,
      // No base/override, but the upstream host the Hub proxy connects over is
      // always allowed (Vite still also allows loopback).
      allowedHosts: ['host.docker.internal'],
      hmr: { protocol: 'wss', clientPort: 443 },
      watch: { usePolling: true, interval: 300 },
    });
    // Same-origin /api proxied to the compose `server` service by default.
    expect(cfg!.proxy['/api']).toBe('http://server:3051');
    expect(cfg!.proxy['/uploads']).toBe('http://server:3051');
    expect(cfg!.proxy['/design-files']).toBe('http://server:3051');
    // The nested app's live WebSocket (/ws) must be upgraded to the server too.
    expect(cfg!.proxy['/ws']).toEqual({ target: 'http://server:3051', ws: true });
  });

  it('honors FRONTEND_PORT and override envs', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      FRONTEND_PORT: '4173',
      AGENT_HUB_PREVIEW_API_TARGET: 'http://backend:9000',
      AGENT_HUB_PREVIEW_HMR_CLIENT_PORT: '8443',
      AGENT_HUB_PREVIEW_HMR_PROTOCOL: 'ws',
    });
    expect(cfg!.port).toBe(4173);
    expect(cfg!.hmr).toEqual({ protocol: 'ws', clientPort: 8443 });
    expect(cfg!.proxy['/api']).toBe('http://backend:9000');
  });

  it('defaults the port to 80 when FRONTEND_PORT is missing or junk', () => {
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' })!.port).toBe(80);
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', FRONTEND_PORT: 'abc' })!.port).toBe(
      80,
    );
  });

  it('scopes allowedHosts to the *.preview.<base> subdomains plus the upstream host', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.agenthub.surveytracker.io',
    });
    // Public subdomain Host (browser) AND the internal upstream Host the Hub
    // proxy forwards (host.docker.internal) — both must be accepted by Vite.
    expect(cfg!.allowedHosts).toEqual([
      '.preview.agenthub.surveytracker.io',
      'host.docker.internal',
    ]);
  });
});

describe('resolvePreviewUpstreamAllowedHost', () => {
  it('defaults to host.docker.internal (the DinD upstream)', () => {
    expect(resolvePreviewUpstreamAllowedHost({})).toBe('host.docker.internal');
  });

  it('follows AGENT_HUB_PREVIEW_HEALTH_HOST when the operator overrides it', () => {
    expect(resolvePreviewUpstreamAllowedHost({ AGENT_HUB_PREVIEW_HEALTH_HOST: '10.0.0.5' })).toBe(
      '10.0.0.5',
    );
  });
});

describe('resolvePreviewAllowedHosts', () => {
  it('allows the upstream host even with no base or override set', () => {
    // Regression: the Hub preview proxy forwards Host: host.docker.internal to
    // the dev server; if Vite does not allow it, every proxied iframe request
    // 403s ("Blocked request. This host is not allowed.") even though the
    // readiness probe (which fakes Host: localhost) reports the preview ready.
    expect(resolvePreviewAllowedHosts({})).toEqual(['host.docker.internal']);
  });

  it('derives `.<base>` (host + subdomains) and appends the upstream host', () => {
    expect(
      resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.example.com' }),
    ).toEqual(['.preview.example.com', 'host.docker.internal']);
    // tolerant of a stray leading dot in the env value
    expect(
      resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: '.preview.example.com' }),
    ).toEqual(['.preview.example.com', 'host.docker.internal']);
  });

  it('honors an explicit comma-separated override list and still appends the upstream host', () => {
    expect(
      resolvePreviewAllowedHosts({
        AGENT_HUB_PREVIEW_ALLOWED_HOSTS: 'a.example.com, b.example.com',
      }),
    ).toEqual(['a.example.com', 'b.example.com', 'host.docker.internal']);
  });

  it('does not duplicate the upstream host when it is already listed', () => {
    expect(
      resolvePreviewAllowedHosts({
        AGENT_HUB_PREVIEW_ALLOWED_HOSTS: 'host.docker.internal, a.example.com',
      }),
    ).toEqual(['host.docker.internal', 'a.example.com']);
  });

  it('follows a custom AGENT_HUB_PREVIEW_HEALTH_HOST into the allow list', () => {
    expect(
      resolvePreviewAllowedHosts({
        AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.example.com',
        AGENT_HUB_PREVIEW_HEALTH_HOST: 'gateway.internal',
      }),
    ).toEqual(['.preview.example.com', 'gateway.internal']);
  });

  it('only allows unrestricted mode as an explicit opt-in (*/all)', () => {
    expect(resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_ALLOWED_HOSTS: '*' })).toBe(true);
    expect(resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_ALLOWED_HOSTS: 'all' })).toBe(true);
  });
});
