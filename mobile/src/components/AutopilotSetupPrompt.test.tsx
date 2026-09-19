import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock('../utils/api', () => ({ api: { uploadFile: vi.fn(), startSessionAutopilot: vi.fn() } }));

const { api } = await import('../utils/api');
const documents = await import('expo-document-picker');
const photos = await import('expo-image-picker');
const { default: AutopilotSetupPrompt } = await import('./AutopilotSetupPrompt');
const uploaded = {
  id: 'upload-1',
  filename: 'upload-1.pdf',
  originalName: 'spec.pdf',
  contentType: 'application/pdf',
  url: '/uploads/upload-1.pdf',
};
let renderer: ReactTestRenderer;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(documents.getDocumentAsync).mockResolvedValue({
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
  vi.mocked(api.uploadFile).mockResolvedValue(uploaded);
  await act(async () => {
    renderer = TestRenderer.create(<AutopilotSetupPrompt sessionId="session-1" />);
  });
  await act(async () => {
    for (const [field, value] of [
      ['brief', 'Use the reference'],
      ['goal', 'Matches reference'],
      ['branch', 'autopilot/reference'],
    ]) {
      renderer.root.findByProps({ testID: `autopilot-setup-${field}` }).props.onChangeText(value);
    }
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});

async function press(label: string) {
  await act(async () => {
    await renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
  });
}
async function start() {
  await act(async () => {
    await renderer.root.findByProps({ testID: 'autopilot-setup-start' }).props.onPress();
  });
}

describe('Autopilot attachments on mobile', () => {
  it('uploads selected documents and includes them in the opening request', async () => {
    await press('Attach files');
    await start();
    expect(api.uploadFile).toHaveBeenCalledWith({
      uri: 'file:///spec.pdf',
      name: 'spec.pdf',
      type: 'application/pdf',
      size: 12,
    });
    expect(api.startSessionAutopilot).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ images: [uploaded] }),
    );
  });

  it('allows removing a selected photo before starting', async () => {
    vi.mocked(photos.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///reference.png',
          fileName: 'reference.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
        },
      ],
    });
    await press('Attach photos or videos');
    await press('Remove reference.png');
    await start();
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(api.startSessionAutopilot).toHaveBeenCalledWith(
      'session-1',
      expect.not.objectContaining({ images: expect.anything() }),
    );
  });

  it('retains files and prevents starting after an upload failure', async () => {
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new Error('Upload failed'));
    await press('Attach files');
    await start();
    expect(api.startSessionAutopilot).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Upload failed');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Remove spec.pdf' })).toBeTruthy();
    await start();
    expect(api.startSessionAutopilot).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ images: [uploaded] }),
    );
  });
});
