import { describe, it, expect } from 'vitest';
import {
  resolvePreviewClientUrl,
  previewUpstreamPath,
  previewProxyMountPath,
} from './preview-public-url.js';

describe('resolvePreviewClientUrl', () => {
  it('uses localhost when publicUrl is unset', () => {
    expect(resolvePreviewClientUrl(null, 'sess-1', 4100)).toBe('http://localhost:4100');
  });

  it('uses same-origin proxy when publicUrl is set', () => {
    expect(resolvePreviewClientUrl('https://hub.example.com', 'sess-1', 4100)).toBe(
      'https://hub.example.com/api/sessions/sess-1/preview/proxy',
    );
  });
});

describe('previewUpstreamPath', () => {
  it('rewrites proxy mount to upstream root path', () => {
    const mount = previewProxyMountPath('abc');
    expect(previewUpstreamPath(`${mount}/dashboard?x=1`, 'abc')).toBe('/dashboard?x=1');
  });
});
