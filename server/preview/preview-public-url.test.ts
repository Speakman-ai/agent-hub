import { describe, it, expect } from 'vitest';
import {
  resolvePreviewClientUrl,
  previewUpstreamPath,
  previewProxyMountPath,
  devServerPortProxyPath,
  resolveDevServerPortClientUrl,
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
});

describe('previewUpstreamPath', () => {
  it('rewrites proxy mount to upstream root path', () => {
    const mount = previewProxyMountPath('abc');
    expect(previewUpstreamPath(`${mount}/dashboard?x=1`, 'abc')).toBe('/dashboard?x=1');
  });
});
