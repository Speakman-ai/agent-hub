import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const webView = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: platform,
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Image: 'Image',
  Modal: 'Modal',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@kishannareshpal/expo-pdf', () => {
  throw new Error("Cannot find native module 'KJExpoPdf'");
});
vi.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    webView.render(props);
    return React.createElement('WebView', props);
  },
}));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));

const { SessionArtifactViewerContent } = await import('./SessionArtifactViewerModal');

describe('PDF preview without KJExpoPdf (Expo Go)', () => {
  it('shows a local PDF in the iOS web view instead of crashing at startup', () => {
    platform.OS = 'ios';
    const html = renderToStaticMarkup(
      <SessionArtifactViewerContent
        artifact={{ filename: 'report.pdf' }}
        kind="pdf"
        resource={{ uri: 'file:///report.pdf' }}
      />,
    );
    expect(html).toContain('session-artifact-viewer-pdf');
    expect(html).toContain('WebView');
    expect(webView.render).toHaveBeenCalledWith(
      expect.objectContaining({ source: { uri: 'file:///report.pdf' } }),
    );
  });

  it('does not hand a local PDF to the Android web view', () => {
    platform.OS = 'android';
    webView.render.mockClear();
    const html = renderToStaticMarkup(
      <SessionArtifactViewerContent
        artifact={{ filename: 'report.pdf' }}
        kind="pdf"
        resource={{ uri: 'file:///report.pdf' }}
      />,
    );
    expect(html).toContain('session-artifact-viewer-pdf-unavailable');
    expect(html).toContain('Expo Go');
    expect(webView.render).not.toHaveBeenCalled();
  });
});
