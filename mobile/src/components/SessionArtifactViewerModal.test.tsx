import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
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
vi.mock('@kishannareshpal/expo-pdf', () => ({ PdfView: 'PdfView' }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));

import { SessionArtifactViewerContent } from './SessionArtifactViewerModal';

describe('SessionArtifactViewerContent (mobile)', () => {
  it('renders generated markdown inside the app', () => {
    const html = renderToStaticMarkup(
      <SessionArtifactViewerContent
        artifact={{ filename: 'report.md' }}
        kind="markdown"
        resource={{ text: '# Generated report' }}
      />,
    );
    expect(html).toContain('Markdown');
    expect(html).toContain('# Generated report');
  });

  it('renders PDFs and images in dedicated full-screen native resources', () => {
    const pdf = renderToStaticMarkup(
      <SessionArtifactViewerContent
        artifact={{ filename: 'report.pdf' }}
        kind="pdf"
        resource={{ uri: 'file:///report.pdf' }}
      />,
    );
    const image = renderToStaticMarkup(
      <SessionArtifactViewerContent
        artifact={{ filename: 'chart.png' }}
        kind="image"
        resource={{ uri: 'file:///chart.png' }}
      />,
    );
    expect(pdf).toContain('session-artifact-viewer-pdf');
    expect(pdf).toContain('PdfView');
    expect(image).toContain('session-artifact-viewer-image');
  });
});
