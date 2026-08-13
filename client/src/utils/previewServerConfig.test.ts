import { describe, it, expect } from 'vitest';
import {
  isPreviewMode,
  buildPreviewServerConfig,
  PREVIEW_WATCH_IGNORED,
  resolvePreviewAllowedHosts,
  resolvePreviewUpstreamAllowedHost,
} from './previewServerConfig';

describe('isPreviewMode', () => {
  it('is false when AGENT_HUB_PREVIEW is unset', () => {
    expect(isPreviewMode({})).toBe(false);
    expect(isPreviewMode({ PORT: '4711' })).toBe(false);
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
    expect(buildPreviewServerConfig({ PORT: '4711', VITE_API_PORT: '3051' })).toBeNull();
  });

  it('builds an HMR-over-proxy server config in preview mode', () => {
    const cfg = buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' });
    expect(cfg!).toMatchObject({
      host: '0.0.0.0',
      port: 3050,
      // No base/override, but the upstream host the Hub proxy connects over is
      // always allowed (Vite still also allows loopback).
      allowedHosts: ['host.docker.internal'],
      watch: { usePolling: true, interval: 300, ignored: PREVIEW_WATCH_IGNORED },
    });
    // No `hmr` block by default: Vite's client infers host/port/protocol from
    // the location it was served from, which is already right behind a
    // same-origin proxy. Pinning wss:443 broke every non-TLS-on-443 Hub.
    expect(cfg!.hmr).toBeUndefined();
    // Same-origin /api proxied over loopback to the nested API by default.
    expect(cfg!.proxy['/api']).toEqual({ target: 'http://127.0.0.1:3051', ws: true });
    expect(cfg!.proxy['/uploads']).toBe('http://127.0.0.1:3051');
    expect(cfg!.proxy['/design-files']).toBe('http://127.0.0.1:3051');
    // The nested app's live WebSocket (/ws) must be upgraded to the server too.
    expect(cfg!.proxy['/ws']).toEqual({ target: 'http://127.0.0.1:3051', ws: true });
  });

  it('emits an hmr block only when an operator overrides the transport', () => {
    expect(
      buildPreviewServerConfig({
        AGENT_HUB_PREVIEW: '1',
        AGENT_HUB_PREVIEW_HMR_CLIENT_PORT: '8443',
      })!.hmr,
    ).toEqual({ clientPort: 8443 });
    expect(
      buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', AGENT_HUB_PREVIEW_HMR_PROTOCOL: 'ws' })!
        .hmr,
    ).toEqual({ protocol: 'ws' });
    expect(
      buildPreviewServerConfig({
        AGENT_HUB_PREVIEW: '1',
        AGENT_HUB_PREVIEW_HMR_PROTOCOL: 'wss',
        AGENT_HUB_PREVIEW_HMR_CLIENT_PORT: '443',
      })!.hmr,
    ).toEqual({ protocol: 'wss', clientPort: 443 });
  });

  it('binds the PORT the dev-server runtime injects, not a fixed port', () => {
    // Regression: the host session-env backend pool-allocates the primary
    // portMap host port and announces it as PORT. Binding the configured
    // internalPort (3050) instead leaves the readiness probe dialling a dead
    // port until the full budget expires.
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', PORT: '4712' })!.port).toBe(4712);
  });

  it('follows AGENT_HUB_PORT for the /api proxy target', () => {
    // The nested API binds AGENT_HUB_PORT; agent-hub pins it off 3051 so a
    // self-preview does not collide with the outer Hub on the host backend.
    const cfg = buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', AGENT_HUB_PORT: '3151' });
    expect(cfg!.proxy['/api']).toEqual({ target: 'http://127.0.0.1:3151', ws: true });
    expect(cfg!.proxy['/ws']).toEqual({ target: 'http://127.0.0.1:3151', ws: true });
  });

  it('ignores the nested Hub preview data directory so runtime writes do not thrash HMR', () => {
    const cfg = buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' });
    expect(cfg!.watch.ignored).toContain('**/.agent-hub-preview/**');
  });

  it('honors PORT and override envs', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      PORT: '4173',
      AGENT_HUB_PREVIEW_API_TARGET: 'http://backend:9000',
      AGENT_HUB_PREVIEW_HMR_CLIENT_PORT: '8443',
      AGENT_HUB_PREVIEW_HMR_PROTOCOL: 'ws',
    });
    expect(cfg!.port).toBe(4173);
    expect(cfg!.hmr).toEqual({ protocol: 'ws', clientPort: 8443 });
    expect(cfg!.proxy['/api']).toEqual({ target: 'http://backend:9000', ws: true });
  });

  it('defaults the port to 3050 when PORT is missing or junk', () => {
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' })!.port).toBe(3050);
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', PORT: 'abc' })!.port).toBe(3050);
  });

  it('scopes allowedHosts to the *.preview.<base> subdomains plus the upstream host', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.agenthub.example.com',
    });
    // Public subdomain Host (browser) AND the internal upstream Host the Hub
    // proxy forwards (host.docker.internal) — both must be accepted by Vite.
    expect(cfg!.allowedHosts).toEqual(['.preview.agenthub.example.com', 'host.docker.internal']);
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
