import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const auth = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  isAuthenticated: vi.fn(() => false),
  needsEmailUpdate: vi.fn(() => false),
  login: vi.fn(),
  clearToken: vi.fn(),
}));
const picker = vi.hoisted(() => ({
  start: null as null | (() => boolean),
  end: null as null | (() => void),
  disabled: undefined as boolean | undefined,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  KeyboardAvoidingView: nativeHost('KeyboardAvoidingView'),
  Platform: { OS: 'ios' },
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('./BrandLogo', () => ({ default: () => null }));
vi.mock('./LoginServerPicker', () => ({
  default: ({ onServerChangeStart, onServerChangeEnd, disabled }: any) => {
    picker.start = onServerChangeStart;
    picker.end = onServerChangeEnd;
    picker.disabled = disabled;
    return null;
  },
}));
vi.mock('../utils/auth', () => ({
  completeMfaLogin: vi.fn(),
  forgotPassword: vi.fn(),
  getAuthStatus: (...a: any[]) => auth.getAuthStatus(...a),
  isAuthenticated: () => auth.isAuthenticated(),
  login: (...a: any[]) => auth.login(...a),
  clearToken: (...a: any[]) => auth.clearToken(...a),
  needsEmailUpdate: () => auth.needsEmailUpdate(),
  setup: vi.fn(),
  updateEmail: vi.fn(),
}));
vi.mock('../utils/config', () => ({ getApiBaseUrl: vi.fn(() => 'https://hub.example.com/api') }));

const { default: LoginScreen, resolveProbedLoginMode } = await import('./LoginScreen');

const REMOTE_AUTH = { authConfigured: true, activeOrgIsLocal: false, needsEmailUpdate: false };
const LOCAL_BYPASS = { authConfigured: true, activeOrgIsLocal: true, needsEmailUpdate: false };

/** Stand-in for App.tsx: LoginScreen while `needsAuth`, the app otherwise. */
function Gate() {
  const [needsAuth, setNeedsAuth] = React.useState(true);
  if (!needsAuth) return React.createElement('MainApp');
  return <LoginScreen onAuthenticated={() => setNeedsAuth(false)} onSwitchOrg={vi.fn()} />;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('LoginScreen server switch re-evaluates the app auth gate', () => {
  beforeEach(() => {
    auth.getAuthStatus.mockReset();
    auth.isAuthenticated.mockReturnValue(false);
    auth.needsEmailUpdate.mockReturnValue(false);
    picker.start = null;
    picker.end = null;
    picker.disabled = undefined;
    auth.login.mockReset();
    auth.clearToken.mockReset().mockResolvedValue(undefined);
  });

  it('releases the gate after switching to a server the app would not gate on', async () => {
    auth.getAuthStatus.mockResolvedValueOnce(REMOTE_AUTH).mockResolvedValueOnce(LOCAL_BYPASS);
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(0);

    await TestRenderer.act(async () => {
      expect(picker.start!()).toBe(true);
      picker.end!();
      await flush();
    });
    expect(auth.getAuthStatus).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(1);
  });

  it('keeps the gate when the new server still requires sign-in', async () => {
    auth.getAuthStatus.mockResolvedValue(REMOTE_AUTH);
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    await TestRenderer.act(async () => {
      expect(picker.start!()).toBe(true);
      picker.end!();
      await flush();
    });
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(0);
  });
});

describe('resolveProbedLoginMode', () => {
  const base = { isAuthenticatedValue: false, needsEmailUpdateValue: false };

  it('keeps the first-mount decision to the parent (no release before a switch)', () => {
    expect(resolveProbedLoginMode({ ...base, status: LOCAL_BYPASS, serverChanged: false })).toBe(
      'login',
    );
    expect(
      resolveProbedLoginMode({ ...base, status: { authConfigured: false }, serverChanged: false }),
    ).toBe('setup');
  });

  it('releases after a switch only when the gate policy says so', () => {
    expect(resolveProbedLoginMode({ ...base, status: LOCAL_BYPASS, serverChanged: true })).toBe(
      'release',
    );
    expect(resolveProbedLoginMode({ ...base, status: REMOTE_AUTH, serverChanged: true })).toBe(
      'login',
    );
  });

  it('still requires a pending email update instead of releasing', () => {
    expect(
      resolveProbedLoginMode({
        ...base,
        status: { ...LOCAL_BYPASS, needsEmailUpdate: true },
        serverChanged: true,
      }),
    ).toBe('email-update');
    expect(
      resolveProbedLoginMode({
        ...base,
        needsEmailUpdateValue: true,
        status: LOCAL_BYPASS,
        serverChanged: true,
      }),
    ).toBe('email-update');
  });
});

describe('LoginScreen sign-in racing a server switch', () => {
  beforeEach(() => {
    auth.getAuthStatus.mockReset().mockResolvedValue(REMOTE_AUTH);
    auth.isAuthenticated.mockReturnValue(false);
    auth.needsEmailUpdate.mockReturnValue(false);
    auth.login.mockReset();
    auth.clearToken.mockReset().mockResolvedValue(undefined);
    picker.start = null;
    picker.end = null;
    picker.disabled = undefined;
  });

  async function startSignIn(renderer: ReactTestRenderer) {
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'login-username' }).props.onChangeText('me@a.example');
      renderer.root.findByProps({ testID: 'login-password' }).props.onChangeText('pw');
    });
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'login-submit' }).props.onPress();
      await flush();
    });
  }

  it('locks the server picker while a sign-in is in flight', async () => {
    let resolveLogin!: (v: any) => void;
    auth.login.mockReturnValue(new Promise((r) => (resolveLogin = r)));
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    expect(picker.disabled).toBe(false);
    await startSignIn(renderer);
    expect(picker.disabled).toBe(true);
    await TestRenderer.act(async () => {
      resolveLogin({ mfaRequired: false });
      await flush();
    });
  });

  it('refuses to start a switch while a sign-in is in flight', async () => {
    let resolveLogin!: (v: any) => void;
    auth.login.mockReturnValue(new Promise((r) => (resolveLogin = r)));
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    await startSignIn(renderer);
    // The picker's synchronous start check is refused even before the
    // `disabled` prop re-render lands, so no switch can interleave.
    expect(picker.start!()).toBe(false);
    await TestRenderer.act(async () => {
      resolveLogin({ mfaRequired: false });
      await flush();
    });
    // The sign-in was for the server still connected, so it completes.
    expect(auth.clearToken).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(1);
  });

  it('blocks sign-in from the moment a switch starts until it settles', async () => {
    auth.login.mockResolvedValue({ mfaRequired: false });
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'login-username' }).props.onChangeText('me@a.example');
      renderer.root.findByProps({ testID: 'login-password' }).props.onChangeText('pw');
    });

    // The picker has started a switch whose connection change is still pending.
    await TestRenderer.act(async () => {
      expect(picker.start!()).toBe(true);
      await flush();
    });
    expect(renderer.root.findByProps({ testID: 'login-submit' }).props.disabled).toBe(true);
    // Even a press that bypasses the disabled button is refused.
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'login-submit' }).props.onPress();
      await flush();
    });
    expect(auth.login).not.toHaveBeenCalled();
    // A second switch can't overlap the first either.
    expect(picker.start!()).toBe(false);

    await TestRenderer.act(async () => {
      picker.end!();
      await flush();
    });
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(0);
    expect(auth.getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('ignores a status probe from an earlier switch that resolves during the next one', async () => {
    let resolveStaleProbe!: (v: any) => void;
    auth.getAuthStatus
      .mockResolvedValueOnce(REMOTE_AUTH) // initial mount
      .mockReturnValueOnce(new Promise((r) => (resolveStaleProbe = r))) // after switch 1
      .mockResolvedValue(REMOTE_AUTH); // after switch 2
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(<Gate />);
      await flush();
    });
    await TestRenderer.act(async () => {
      expect(picker.start!()).toBe(true);
      picker.end!();
      await flush();
    });
    await TestRenderer.act(async () => {
      expect(picker.start!()).toBe(true);
      // Switch 1's server answers with a status that would release the gate,
      // but the user has already started leaving it.
      resolveStaleProbe(LOCAL_BYPASS);
      await flush();
    });
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(0);
    await TestRenderer.act(async () => {
      picker.end!();
      await flush();
    });
    expect(renderer.root.findAllByType('MainApp' as any)).toHaveLength(0);
  });
});
