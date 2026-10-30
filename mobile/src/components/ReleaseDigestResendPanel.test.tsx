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

const alertMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: alertMock },
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));

vi.mock('../utils/api', () => ({
  api: {
    generateReleaseDigest: vi.fn(),
    resendReleaseDigest: vi.fn(),
    getReleaseNotificationSettings: vi.fn(),
    testReleaseDigest: vi.fn(),
  },
}));

vi.mock('../theme/colors', () => ({
  colors: new Proxy({}, { get: () => '#000000' }),
}));

const { api } = await import('../utils/api');
const { default: ReleaseDigestResendPanel } = await import('./ReleaseDigestResendPanel');
const { default: ReleaseNotificationSettingsSection } =
  await import('./settings/ReleaseNotificationSettingsSection');

const generate = vi.mocked(api.generateReleaseDigest);
const resend = vi.mocked(api.resendReleaseDigest);
const getSettings = vi.mocked(api.getReleaseNotificationSettings);
const testDigest = vi.mocked(api.testReleaseDigest);

async function flush() {
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = renderer.root.findByProps({ testID });
  await TestRenderer.act(async () => {
    node.props.onPress();
  });
  await flush();
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as any) === 'Text')
    .flatMap((node) => node.children)
    .map((child) => (typeof child === 'string' ? child : ''))
    .join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mobile ReleaseDigestResendPanel', () => {
  it('generates, accepts an edit, and sends the edited text after confirmation', async () => {
    generate.mockResolvedValue({
      digestMarkdown: '### Admin Updates\n\nGenerated.',
      subject: 'Release digest for production 1.0.322',
    } as any);
    resend.mockResolvedValue({ queued: [{ id: 'n' }], releaseNotifications: [{ id: 'n' }] } as any);
    const onQueued = vi.fn();
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ReleaseDigestResendPanel projectId="p1" deploymentId="d1" onQueued={onQueued} />,
      );
    });

    await press(renderer, 'release-digest-resend-open');
    expect(generate).toHaveBeenCalledWith('p1', 'd1');
    const body = renderer.root.findByProps({ testID: 'release-digest-body' });
    expect(body.props.value).toBe('### Admin Updates\n\nGenerated.');
    await TestRenderer.act(async () => {
      body.props.onChangeText('### Admin Updates\n\nEdited.');
    });

    await press(renderer, 'release-digest-send');
    expect(resend).not.toHaveBeenCalled();
    const buttons = alertMock.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    await TestRenderer.act(async () => {
      buttons.find((button) => button.text === 'Send')?.onPress?.();
    });
    await flush();

    expect(resend).toHaveBeenCalledWith('p1', 'd1', {
      digestMarkdown: '### Admin Updates\n\nEdited.',
      subject: 'Release digest for production 1.0.322',
    });
    expect(onQueued).toHaveBeenCalledWith([{ id: 'n' }]);
  });
});

describe('mobile ReleaseNotificationSettingsSection test generate', () => {
  it('test-generates with the current prompt and shows the digest', async () => {
    getSettings.mockResolvedValue({
      projectId: 'p1',
      releaseDigestPrompt: 'Split by department.',
      isDefault: false,
      promptMaxLength: 4000,
      releaseDigestRecipients: [],
    } as any);
    testDigest.mockResolvedValue({
      digestMarkdown: 'Invoices are faster.',
      subject: 'Release digest for production 1.0.322',
      deployment: { id: 'd1', environment: 'production', label: '1.0.322', status: 'success' },
      releaseItemCount: 2,
    } as any);
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<ReleaseNotificationSettingsSection projectId="p1" />);
    });
    await flush();

    await press(renderer, 'release-digest-test-generate');

    expect(testDigest).toHaveBeenCalledWith('p1', { releaseDigestPrompt: 'Split by department.' });
    expect(renderer.root.findAllByProps({ testID: 'release-digest-test-result' })).not.toHaveLength(
      0,
    );
    expect(allText(renderer)).toContain('Invoices are faster.');
  });
});
