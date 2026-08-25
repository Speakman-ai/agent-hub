import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

// Vitest inherits NODE_ENV=production in Agent Hub's test runner. Load the
// development React renderer explicitly so hooks/effects can be flushed.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Image: nativeHost('Image'),
  Modal: nativeHost('Modal'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));

// react-native-webview ships untranspiled — mock it to a plain host element so
// the component (and this suite) don't try to transform the native module.
vi.mock('react-native-webview', () => ({
  WebView: nativeHost('WebView'),
}));

vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  api: {
    getProjectEmailLogo: vi.fn(),
    updateProjectEmailLogo: vi.fn(),
    deleteProjectEmailLogo: vi.fn(),
    getReleaseEmailPreview: vi.fn(),
  },
}));

vi.mock('../../utils/config', () => ({
  getApiBaseUrl: () => 'http://host/api',
  getAuthHeaders: () => ({}),
}));

vi.mock('../../utils/auth', () => ({ hasRole: () => true }));

vi.mock('../../theme/colors', () => ({
  colors: new Proxy({}, { get: () => '#000000' }),
}));

const ImagePicker = await import('expo-image-picker');
const { api } = await import('../../utils/api');
const { default: ProjectEmailLogoSection } = await import('./ProjectEmailLogoSection');

const permMock = vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchMock = vi.mocked(ImagePicker.launchImageLibraryAsync);
const getLogo = vi.mocked(api.getProjectEmailLogo);
const updateLogo = vi.mocked(api.updateProjectEmailLogo);
const getPreview = vi.mocked(api.getReleaseEmailPreview);

async function flush() {
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderAt(projectId: string) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<ProjectEmailLogoSection projectId={projectId} />);
  });
  await flush();
  return renderer;
}

async function update(renderer: ReactTestRenderer, projectId: string) {
  await TestRenderer.act(async () => {
    renderer.update(<ProjectEmailLogoSection projectId={projectId} />);
  });
  await flush();
}

async function pressUpload(renderer: ReactTestRenderer) {
  const btn = renderer.root.findByProps({ testID: 'project-email-logo-upload' });
  await TestRenderer.act(async () => {
    btn.props.onPress();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  getLogo.mockResolvedValue({ emailLogo: null } as any);
  permMock.mockResolvedValue({ granted: true } as any);
  updateLogo.mockResolvedValue({ emailLogo: { filename: 'x', contentType: 'image/png' } } as any);
  getPreview.mockResolvedValue({
    html: '<html><body><h1>Preview body</h1></body></html>',
    subject: "What's new",
    usingProjectLogo: false,
  } as any);
});

describe('mobile ProjectEmailLogoSection stale-project guards', () => {
  it('does not upload a stale pick across an A→B→A switch', async () => {
    // The picker stays open (pending) so we can switch projects mid-interaction.
    let resolvePicker: (v: any) => void = () => {};
    launchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }) as any,
    );

    const renderer = await renderAt('p1');
    await pressUpload(renderer); // handlePick claims its generation, picker pending

    // Navigate p1 → p2 → p1 while the picker is open.
    await update(renderer, 'p2');
    await update(renderer, 'p1');

    // The stale pick resolves; identity is p1 again but the generation is stale.
    await TestRenderer.act(async () => {
      resolvePicker({ canceled: false, assets: [{ base64: 'AAA', mimeType: 'image/png' }] });
      await Promise.resolve();
    });

    expect(updateLogo).not.toHaveBeenCalled();
  });

  it('opens the email preview WebView with the rendered HTML', async () => {
    const renderer = await renderAt('p1');
    const btn = renderer.root.findByProps({ testID: 'project-email-logo-preview' });
    await TestRenderer.act(async () => {
      btn.props.onPress();
    });
    await flush();
    expect(getPreview).toHaveBeenCalledWith('p1');
    const webview = renderer.root.findByType('WebView' as any);
    expect(webview.props.source.html).toContain('Preview body');
  });

  it('uploads normally when the project does not change', async () => {
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [{ base64: 'AAA', mimeType: 'image/png' }],
    } as any);

    const renderer = await renderAt('p1');
    await pressUpload(renderer);

    expect(updateLogo).toHaveBeenCalledTimes(1);
    expect(updateLogo).toHaveBeenCalledWith('p1', 'data:image/png;base64,AAA');
  });
});
