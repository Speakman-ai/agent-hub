import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  orgs: {
    activeOrgId: 'a',
    orgs: [
      { id: 'a', name: 'Acme', color: '#111', remoteUrl: 'https://acme.example.com' },
      { id: 'b', name: 'Beta', color: '#222', remoteUrl: 'https://beta.example.com' },
    ],
  } as any,
  updateOrg: vi.fn(),
  clearToken: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('../utils/orgs', () => ({
  getOrgs: () => testState.orgs,
  updateOrg: (...args: any[]) => testState.updateOrg(...args),
}));
vi.mock('../utils/auth', () => ({
  clearToken: (...args: any[]) => testState.clearToken(...args),
}));

const { default: LoginServerPicker } = await import('./LoginServerPicker');

async function renderPicker(props: {
  onSwitchOrg: any;
  onServerChangeEnd: any;
  onServerChangeStart?: any;
}) {
  const onServerChangeStart = props.onServerChangeStart ?? vi.fn(() => true);
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <LoginServerPicker {...props} onServerChangeStart={onServerChangeStart} />,
    );
    await Promise.resolve();
  });
  return renderer;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  await TestRenderer.act(async () => {
    renderer.root.findByProps({ testID }).props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('mobile LoginServerPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.updateOrg.mockResolvedValue(undefined);
    testState.clearToken.mockResolvedValue(undefined);
  });

  async function editUrlTo(renderer: ReactTestRenderer, value: string) {
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-edit');
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'login-server-url-input' }).props.onChangeText(value);
    });
    await press(renderer, 'login-server-save');
  }

  it('shows the org the login page is pointed at', async () => {
    const renderer = await renderPicker({ onSwitchOrg: vi.fn(), onServerChangeEnd: vi.fn() });
    expect(renderer.root.findByProps({ testID: 'login-server-name' }).props.children).toBe('Acme');
    expect(renderer.root.findByProps({ testID: 'login-server-url' }).props.children).toBe(
      'https://acme.example.com',
    );
  });

  it('swaps to another org and asks the login screen to re-probe', async () => {
    const onSwitchOrg = vi.fn().mockResolvedValue(undefined);
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeEnd });
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-org-b');
    expect(onSwitchOrg).toHaveBeenCalledWith('b');
    expect(onServerChangeEnd).toHaveBeenCalledTimes(1);
    // Acme's JWT must be gone before the connection points at Beta.
    expect(testState.clearToken).toHaveBeenCalledTimes(1);
    expect(testState.clearToken.mock.invocationCallOrder[0]).toBeLessThan(
      onSwitchOrg.mock.invocationCallOrder[0],
    );
  });

  it('claims the transition from the login screen before any switch work', async () => {
    const onSwitchOrg = vi.fn().mockResolvedValue(undefined);
    const onServerChangeStart = vi.fn(() => true);
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeStart, onServerChangeEnd });
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-org-b');
    expect(onServerChangeStart).toHaveBeenCalledTimes(1);
    expect(onServerChangeStart.mock.invocationCallOrder[0]).toBeLessThan(
      testState.clearToken.mock.invocationCallOrder[0],
    );
    expect(onServerChangeEnd.mock.invocationCallOrder[0]).toBeGreaterThan(
      onSwitchOrg.mock.invocationCallOrder[0],
    );
  });

  it('does nothing when the login screen refuses the transition (sign-in in flight)', async () => {
    const onSwitchOrg = vi.fn();
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({
      onSwitchOrg,
      onServerChangeStart: vi.fn(() => false),
      onServerChangeEnd,
    });
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-org-b');
    expect(testState.clearToken).not.toHaveBeenCalled();
    expect(onSwitchOrg).not.toHaveBeenCalled();
    expect(onServerChangeEnd).not.toHaveBeenCalled();
  });

  it('ends the transition even when the switch fails, so sign-in unlocks', async () => {
    const onSwitchOrg = vi.fn().mockRejectedValue(new Error('offline'));
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeEnd });
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-org-b');
    expect(onServerChangeEnd).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ testID: 'login-server-error' }).props.children).toBe(
      'offline',
    );
  });

  it('edits the URL to a new server without carrying the old credentials', async () => {
    const onSwitchOrg = vi.fn().mockResolvedValue(undefined);
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeEnd });
    await editUrlTo(renderer, 'new-acme.example.com/');
    // The org's API key and the cached JWT were issued by acme.example.com;
    // neither may reach the new host once the switch reconnects.
    expect(testState.updateOrg).toHaveBeenCalledWith('a', {
      remoteUrl: 'https://new-acme.example.com',
      apiKey: '',
    });
    expect(testState.clearToken).toHaveBeenCalledTimes(1);
    expect(testState.clearToken.mock.invocationCallOrder[0]).toBeLessThan(
      onSwitchOrg.mock.invocationCallOrder[0],
    );
    expect(onSwitchOrg).toHaveBeenCalledWith('a');
    expect(onServerChangeEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the credentials when the edit stays on the same server', async () => {
    const onSwitchOrg = vi.fn().mockResolvedValue(undefined);
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeEnd: vi.fn() });
    await editUrlTo(renderer, 'https://acme.example.com/hub/');
    expect(testState.updateOrg).toHaveBeenCalledWith('a', {
      remoteUrl: 'https://acme.example.com/hub',
    });
    expect(testState.clearToken).not.toHaveBeenCalled();
    expect(onSwitchOrg).toHaveBeenCalledWith('a');
  });

  it('rejects an invalid URL without touching the org', async () => {
    const onSwitchOrg = vi.fn();
    const onServerChangeEnd = vi.fn();
    const renderer = await renderPicker({ onSwitchOrg, onServerChangeEnd });
    await press(renderer, 'login-server-change');
    await press(renderer, 'login-server-edit');
    await TestRenderer.act(async () => {
      renderer.root
        .findByProps({ testID: 'login-server-url-input' })
        .props.onChangeText('https://');
    });
    await press(renderer, 'login-server-save');
    expect(renderer.root.findByProps({ testID: 'login-server-error' })).toBeTruthy();
    expect(testState.updateOrg).not.toHaveBeenCalled();
    expect(onSwitchOrg).not.toHaveBeenCalled();
    expect(onServerChangeEnd).not.toHaveBeenCalled();
  });

  it('renders nothing when no orgs exist yet', async () => {
    testState.orgs = null;
    const renderer = await renderPicker({ onSwitchOrg: vi.fn(), onServerChangeEnd: vi.fn() });
    expect(renderer.toJSON()).toBeNull();
    testState.orgs = {
      activeOrgId: 'a',
      orgs: [{ id: 'a', name: 'Acme', remoteUrl: 'https://acme.example.com' }],
    };
  });
});
