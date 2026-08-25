import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  loadArtifactPreview: vi.fn(),
  shareArtifact: vi.fn(),
  webViewRender: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Image: nativeHost('Image'),
  Modal: nativeHost('Modal'),
  Platform: { OS: 'android' },
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('@kishannareshpal/expo-pdf', () => ({ PdfView: nativeHost('NativePdfView') }));
vi.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    testState.webViewRender(props);
    throw new Error('Android WebView cannot render a local PDF');
  },
}));
vi.mock('react-native-markdown-display', () => ({ default: nativeHost('Markdown') }));
vi.mock('./AppIcon', () => ({ default: nativeHost('AppIcon') }));
vi.mock('../utils/artifactContent', () => ({
  loadArtifactPreview: testState.loadArtifactPreview,
  shareArtifact: testState.shareArtifact,
}));

const { default: SessionArtifactViewerModal, SessionArtifactViewerContent } =
  await import('./SessionArtifactViewerModal');

async function renderModal(artifact: any, resource: any) {
  testState.loadArtifactPreview.mockResolvedValueOnce(resource);
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <SessionArtifactViewerModal sessionId="session-1" artifact={artifact} onClose={vi.fn()} />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('SessionArtifactViewerContent on Android', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a cached local PDF with the native PDF renderer instead of WebView', async () => {
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <SessionArtifactViewerContent
          artifact={{ filename: 'report.pdf' }}
          kind="pdf"
          resource={{ uri: 'file:///data/user/0/com.agenthub.mobile/cache/report.pdf' }}
        />,
      );
    });

    const pdf = renderer.root.findByType('NativePdfView' as any);
    expect(pdf.props.uri).toBe('file:///data/user/0/com.agenthub.mobile/cache/report.pdf');
    expect(pdf.props.fitMode).toBe('width');
    expect(testState.webViewRender).not.toHaveBeenCalled();
  });

  it('replaces a corrupt native PDF with a visible render error', async () => {
    const renderer = await renderModal(
      { id: 'artifact-pdf', filename: 'report.pdf', contentType: 'application/pdf' },
      { uri: 'file:///cache/report.pdf' },
    );

    await TestRenderer.act(async () => {
      renderer.root
        .findByType('NativePdfView' as any)
        .props.onError({ code: 'invalid_document', message: 'The PDF document is corrupt.' });
    });

    const error = renderer.root.findByProps({ testID: 'session-artifact-viewer-error' });
    expect(error.findByType('Text' as any).props.children).toBe('The PDF document is corrupt.');
    expect(renderer.root.findAllByType('NativePdfView' as any)).toHaveLength(0);
  });

  it('replaces an undecodable native image with a visible render error', async () => {
    const renderer = await renderModal(
      { id: 'artifact-image', filename: 'chart.png', contentType: 'image/png' },
      { uri: 'file:///cache/chart.png' },
    );

    await TestRenderer.act(async () => {
      renderer.root
        .findByType('Image' as any)
        .props.onError({ nativeEvent: { error: 'The image data is invalid.' } });
    });

    const error = renderer.root.findByProps({ testID: 'session-artifact-viewer-error' });
    expect(error.findByType('Text' as any).props.children).toBe('The image data is invalid.');
    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
  });
});
