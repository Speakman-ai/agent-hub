import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: ({ children }: any) => <div>{children}</div>,
  StyleSheet: {
    create: (s: any) => s,
    absoluteFillObject: {},
  },
  Text: 'Text',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('../utils/api', () => ({ api: {} }));
// Keep the generated 220KB bundle out of the render path — the data: URL builder
// only needs non-empty strings for the mount test.
vi.mock('../utils/rrwebPlayerBundle.generated', () => ({
  RRWEB_PLAYER_JS: 'window.rrwebPlayer={};',
  RRWEB_PLAYER_CSS: '.rr-player{}',
}));

import ReplayWebViewPlayer, { statusLabel } from './ReplayWebViewPlayer';

describe('statusLabel', () => {
  it('shows the connecting copy before streaming starts', () => {
    expect(statusLabel('connecting', { loaded: 0, total: 0 })).toBe('Loading player…');
  });
  it('shows a bounded count while streaming with a known total', () => {
    expect(statusLabel('streaming', { loaded: 40, total: 88 })).toBe('Streaming events 40/88');
  });
  it('clamps the loaded count to the total', () => {
    expect(statusLabel('streaming', { loaded: 200, total: 88 })).toBe('Streaming events 88/88');
  });
  it('shows an unbounded count while streaming with no known total', () => {
    expect(statusLabel('streaming', { loaded: 12, total: 0 })).toBe('Streaming events 12');
  });
  it('shows Playing once the frame is live', () => {
    expect(statusLabel('playing', { loaded: 88, total: 88 })).toBe('Playing');
  });
  it('shows Error on failure', () => {
    expect(statusLabel('error', { loaded: 0, total: 0 })).toBe('Error');
  });
});

describe('ReplayWebViewPlayer mount', () => {
  it('mounts a WebView and the connecting status (effects deferred to runtime)', () => {
    const html = renderToStaticMarkup(
      <ReplayWebViewPlayer target={{ mode: 'session', sessionId: 's-1' }} />,
    );
    // The opaque-origin WebView frame is present.
    expect(html).toContain('WebView');
    expect(html).toContain('replay-webview');
    // Pre-stream status overlay copy.
    expect(html).toContain('Loading player…');
  });

  it('mounts for a monolithic replay target too', () => {
    const html = renderToStaticMarkup(
      <ReplayWebViewPlayer target={{ mode: 'replay', replayId: 'r-1' }} />,
    );
    expect(html).toContain('replay-webview');
  });
});
