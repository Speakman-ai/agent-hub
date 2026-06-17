import { describe, it, expect } from 'vitest';
import {
  isPreviewMode,
  buildPreviewServerConfig,
  resolvePreviewAllowedHosts,
} from './previewServerConfig.js';

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
    expect(cfg).toMatchObject({
      host: '0.0.0.0',
      port: 80,
      // No base/override → most restrictive (Vite still allows loopback).
      allowedHosts: [],
      hmr: { protocol: 'wss', clientPort: 443 },
      watch: { usePolling: true, interval: 300 },
    });
    // Same-origin /api proxied to the compose `server` service by default.
    expect(cfg.proxy['/api']).toBe('http://server:3051');
    expect(cfg.proxy['/uploads']).toBe('http://server:3051');
    expect(cfg.proxy['/design-files']).toBe('http://server:3051');
  });

  it('honors FRONTEND_PORT and override envs', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      FRONTEND_PORT: '4173',
      AGENT_HUB_PREVIEW_API_TARGET: 'http://backend:9000',
      AGENT_HUB_PREVIEW_HMR_CLIENT_PORT: '8443',
      AGENT_HUB_PREVIEW_HMR_PROTOCOL: 'ws',
    });
    expect(cfg.port).toBe(4173);
    expect(cfg.hmr).toEqual({ protocol: 'ws', clientPort: 8443 });
    expect(cfg.proxy['/api']).toBe('http://backend:9000');
  });

  it('defaults the port to 80 when FRONTEND_PORT is missing or junk', () => {
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1' }).port).toBe(80);
    expect(buildPreviewServerConfig({ AGENT_HUB_PREVIEW: '1', FRONTEND_PORT: 'abc' }).port).toBe(
      80,
    );
  });

  it('scopes allowedHosts to the *.preview.<base> subdomains, not a blanket true', () => {
    const cfg = buildPreviewServerConfig({
      AGENT_HUB_PREVIEW: '1',
      AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.agenthub.surveytracker.io',
    });
    expect(cfg.allowedHosts).toEqual(['.preview.agenthub.surveytracker.io']);
  });
});

describe('resolvePreviewAllowedHosts', () => {
  it('returns [] (most restrictive) when no base or override is set', () => {
    expect(resolvePreviewAllowedHosts({})).toEqual([]);
  });

  it('derives `.<base>` (host + subdomains) from the subdomain base', () => {
    expect(
      resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: 'preview.example.com' }),
    ).toEqual(['.preview.example.com']);
    // tolerant of a stray leading dot in the env value
    expect(
      resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_SUBDOMAIN_BASE: '.preview.example.com' }),
    ).toEqual(['.preview.example.com']);
  });

  it('honors an explicit comma-separated override list', () => {
    expect(
      resolvePreviewAllowedHosts({
        AGENT_HUB_PREVIEW_ALLOWED_HOSTS: 'a.example.com, b.example.com',
      }),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('only allows unrestricted mode as an explicit opt-in (*/all)', () => {
    expect(resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_ALLOWED_HOSTS: '*' })).toBe(true);
    expect(resolvePreviewAllowedHosts({ AGENT_HUB_PREVIEW_ALLOWED_HOSTS: 'all' })).toBe(true);
  });
});
