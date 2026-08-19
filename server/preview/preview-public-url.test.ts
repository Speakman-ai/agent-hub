import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePreviewClientUrl,
  previewUpstreamPath,
  previewProxyMountPath,
  devServerPortProxyPath,
  resolveDevServerPortClientUrl,
  resolvePreviewHealthHost,
  resolvePreviewUpstreamHost,
} from './preview-public-url.js';

describe('resolvePreviewClientUrl', () => {
  it('uses localhost when publicUrl is unset', () => {
    expect(resolvePreviewClientUrl(null, 'sess-1', 4100)).toBe('http://localhost:4100');
  });

  it('uses same-origin proxy path when publicUrl is set', () => {
    expect(resolvePreviewClientUrl('https://hub.example.com', 'sess-1', 4100)).toBe(
      '/api/sessions/sess-1/preview/proxy',
    );
  });
});

describe('devServerPortProxyPath', () => {
  it('keeps the back-compat mount for the primary port', () => {
    expect(devServerPortProxyPath('sess-1', 5173, true)).toBe('/api/sessions/sess-1/preview/proxy');
  });

  it('routes extra ports to a /p/<internalPort> sub-mount', () => {
    expect(devServerPortProxyPath('sess-1', 8787, false)).toBe(
      '/api/sessions/sess-1/preview/proxy/p/8787',
    );
  });

  it('url-encodes the session id in the mount', () => {
    expect(devServerPortProxyPath('a/b', 8787, false)).toBe(
      '/api/sessions/a%2Fb/preview/proxy/p/8787',
    );
  });
});

describe('resolveDevServerPortClientUrl', () => {
  it('reaches the loopback host port directly when publicUrl is unset', () => {
    expect(resolveDevServerPortClientUrl(null, 'sess-1', 4180, 8787, false)).toBe(
      'http://localhost:4180',
    );
    expect(resolveDevServerPortClientUrl('   ', 'sess-1', 4100, 5173, true)).toBe(
      'http://localhost:4100',
    );
  });

  it('routes through the same-origin proxy when publicUrl is set', () => {
    expect(
      resolveDevServerPortClientUrl('https://hub.example.com', 'sess-1', 4100, 5173, true),
    ).toBe('/api/sessions/sess-1/preview/proxy');
    expect(
      resolveDevServerPortClientUrl('https://hub.example.com', 'sess-1', 8787, 8787, false),
    ).toBe('/api/sessions/sess-1/preview/proxy/p/8787');
  });

  it('uses the proxy path for env-scoped dial even without publicUrl', () => {
    expect(
      resolveDevServerPortClientUrl(null, 'sess-1', 4180, 8787, false, { useProxy: true }),
    ).toBe('/api/sessions/sess-1/preview/proxy/p/8787');
    expect(
      resolveDevServerPortClientUrl('   ', 'sess-1', 4100, 5173, true, { useProxy: true }),
    ).toBe('/api/sessions/sess-1/preview/proxy');
  });
});

describe('previewUpstreamPath', () => {
  it('rewrites proxy mount to upstream root path', () => {
    const mount = previewProxyMountPath('abc');
    expect(previewUpstreamPath(`${mount}/dashboard?x=1`, 'abc')).toBe('/dashboard?x=1');
  });
});

describe('resolvePreviewHealthHost', () => {
  const prev = process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
    else process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = prev;
  });

  it('returns the configured gateway host when docker features are enabled', () => {
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = 'host.docker.internal';
    expect(resolvePreviewHealthHost(true)).toBe('host.docker.internal');
  });

  it('ignores the gateway host when docker features are disabled', () => {
    // Regression: with docker disabled the preview runs co-resident on the host
    // adapter (loopback). Probing `host.docker.internal` dials the docker bridge
    // gateway where nothing published, so the preview hangs "starting" forever
    // even though Vite is healthy on 127.0.0.1. Fall back to loopback instead.
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = 'host.docker.internal';
    expect(resolvePreviewHealthHost(false)).toBeNull();
  });

  it('returns null when the env var is unset even with docker enabled', () => {
    delete process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
    expect(resolvePreviewHealthHost(true)).toBeNull();
  });

  it('trims whitespace and treats a blank value as unset', () => {
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = '   ';
    expect(resolvePreviewHealthHost(true)).toBeNull();
  });
});

describe('resolvePreviewUpstreamHost', () => {
  const prev = process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
    else process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = prev;
  });

  it('uses the gateway host when docker features are enabled', () => {
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = 'host.docker.internal';
    expect(resolvePreviewUpstreamHost(true)).toBe('host.docker.internal');
  });

  it('falls back to loopback when docker features are disabled', () => {
    process.env.AGENT_HUB_PREVIEW_HEALTH_HOST = 'host.docker.internal';
    expect(resolvePreviewUpstreamHost(false)).toBe('127.0.0.1');
  });

  it('falls back to loopback when the gateway host is unset', () => {
    delete process.env.AGENT_HUB_PREVIEW_HEALTH_HOST;
    expect(resolvePreviewUpstreamHost(true)).toBe('127.0.0.1');
  });
});
