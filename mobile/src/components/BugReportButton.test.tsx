import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Modal: 'Modal',
  Platform: { OS: 'ios', Version: '18' },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-view-shot', () => ({ captureScreen: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('../utils/bugReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/bugReport')>()),
  BUG_REPORT_ENABLED: true,
  captureScreenshot: vi.fn(),
  submitBugReport: vi.fn(),
}));

const documents = await import('expo-document-picker');
const bugReport = await import('../utils/bugReport');
const { default: BugReportButton } = await import('./BugReportButton');

let renderer: ReactTestRenderer;

beforeEach(async () => {
  vi.mocked(bugReport.captureScreenshot)
    .mockReset()
    .mockResolvedValueOnce('file:///primary.png')
    .mockResolvedValueOnce('file:///second.png');
  vi.mocked(bugReport.submitBugReport).mockReset().mockResolvedValue({});
  vi.mocked(documents.getDocumentAsync)
    .mockReset()
    .mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///spec.pdf',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
          size: 12,
          lastModified: 0,
        },
      ],
    });
  await act(async () => {
    renderer = TestRenderer.create(<BugReportButton projectId="p" agentId="a" />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});

const modal = () => renderer.root.findByType('Modal' as any);
const inputs = () => renderer.root.findAllByType('TextInput' as any);
async function press(props: Record<string, string>) {
  await act(async () => {
    await renderer.root.findByProps(props).props.onPress();
  });
}

describe('mobile bug report: Add screenshot', () => {
  it('keeps the draft and primary screenshot and submits the extra screenshot', async () => {
    await press({ accessibilityLabel: 'Report a bug' });
    expect(modal().props.visible).toBe(true);

    await act(async () => {
      inputs()[0]!.props.onChangeText('Upload broken');
      inputs()[1]!.props.onChangeText('PDF never attaches');
    });
    await press({ testID: 'bug-report-attach-files' });

    let pending!: Promise<void>;
    act(() => {
      pending = renderer.root.findByProps({ testID: 'bug-report-add-screenshot' }).props.onPress();
    });
    // The modal hides while the capture runs, then comes back.
    expect(modal().props.visible).toBe(false);
    await act(async () => {
      await pending;
    });
    expect(modal().props.visible).toBe(true);

    expect(inputs()[0]!.props.value).toBe('Upload broken');
    expect(inputs()[1]!.props.value).toBe('PDF never attaches');
    expect(renderer.root.findByType('Image' as any).props.source).toEqual({
      uri: 'file:///primary.png',
    });

    await press({ testID: 'bug-report-submit' });

    expect(bugReport.submitBugReport).toHaveBeenCalledTimes(1);
    const args = vi.mocked(bugReport.submitBugReport).mock.calls[0]![0];
    expect(args.title).toBe('Upload broken');
    expect(args.description).toBe('PDF never attaches');
    expect(args.screenshotUri).toBe('file:///primary.png');
    expect(args.attachments).toEqual([
      { uri: 'file:///spec.pdf', name: 'spec.pdf', type: 'application/pdf' },
      { uri: 'file:///second.png', name: 'screenshot-2.png', type: 'image/png' },
    ]);
  });
});
