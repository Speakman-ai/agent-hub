import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the tree without a native runtime. Matches the LinkedTodosPanel test pattern.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Alert: { alert: vi.fn() },
}));

// AppIcon renders its Ionicons-style name so we can assert which icons appear.
vi.mock('./AppIcon', () => ({
  default: ({ name }: any) => React.createElement('AppIcon', { 'data-name': name }),
}));
vi.mock('@kishannareshpal/expo-pdf', () => ({ PdfView: 'PdfView' }));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));

import { SessionArtifactsPanelContent, isStaleLoad } from './SessionArtifactsPanel';

function artifact(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    size: 2048,
    createdBy: 'agent-hub-dev',
    ...over,
  };
}

describe('SessionArtifactsPanelContent (mobile)', () => {
  it('renders nothing when empty and idle (invisible on ordinary sessions)', () => {
    const html = renderToStaticMarkup(<SessionArtifactsPanelContent artifacts={[]} />);
    expect(html).toBe('');
  });

  it('renders a list with count badge and file metadata when artifacts exist', () => {
    const html = renderToStaticMarkup(
      <SessionArtifactsPanelContent
        artifacts={[artifact(), artifact({ id: 'a2', filename: 'notes.txt', contentType: 'text/plain', size: 512 })]}
      />,
    );
    expect(html).toContain('session-artifacts-panel');
    expect(html).toContain('report.pdf');
    expect(html).toContain('notes.txt');
    // formatBytes(2048) → "2.0 KB"
    expect(html).toContain('2.0 KB');
    expect(html).toContain('agent-hub-dev');
  });

  it('shows a View action only for inline-viewable types', () => {
    const viewable = renderToStaticMarkup(
      <SessionArtifactsPanelContent artifacts={[artifact()]} />,
    );
    expect(viewable).toContain('session-artifacts-view');

    // text/html is scriptable → NOT inline-viewable, so no View button.
    const notViewable = renderToStaticMarkup(
      <SessionArtifactsPanelContent
        artifacts={[artifact({ filename: 'page.html', contentType: 'text/html' })]}
      />,
    );
    expect(notViewable).not.toContain('session-artifacts-view');
    // Download + delete are always present.
    expect(notViewable).toContain('session-artifacts-download');
    expect(notViewable).toContain('session-artifacts-delete');
  });

  it('renders even when empty if an error is present', () => {
    const html = renderToStaticMarkup(
      <SessionArtifactsPanelContent artifacts={[]} error="boom" />,
    );
    expect(html).toContain('session-artifacts-error');
    expect(html).toContain('boom');
  });
});

describe('isStaleLoad (cross-session race guard)', () => {
  it('keeps a load that is still current (same seq + same session)', () => {
    expect(isStaleLoad(3, 3, 'sA', 'sA')).toBe(false);
  });

  it('discards a load superseded by a newer one for the same session (refresh/nonce bump)', () => {
    // seq 2 resolves after seq 3 started → stale even though the session matches.
    expect(isStaleLoad(2, 3, 'sA', 'sA')).toBe(true);
  });

  it('discards a prior-session load that resolves after the session switched', () => {
    // Session A's request (seq 1) resolves while the panel is now mounted for B.
    // Without the guard this would overwrite B's list with A's artifacts and
    // route View/Delete through the wrong sessionId.
    expect(isStaleLoad(1, 1, 'sA', 'sB')).toBe(true);
  });
});
