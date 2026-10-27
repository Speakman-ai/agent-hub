import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

const alert = vi.fn();
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: (...args: unknown[]) => alert(...args) },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../theme/colors', () => ({ colors: {} }));
vi.mock('../../utils/api', () => ({
  api: { getGoogleChatAccount: vi.fn(), setGoogleChatAccount: vi.fn() },
}));

const { api } = await import('../../utils/api');
const { default: GoogleChatAccountPicker } = await import('./GoogleChatAccountPicker');

const candidates = [
  { accountId: 'p', email: 'me@gmail.com', isDefault: true, workspace: false, hasChatScope: false },
  {
    accountId: 'w',
    email: 'me@work.example',
    isDefault: false,
    workspace: true,
    hasChatScope: true,
  },
  {
    accountId: 'x',
    email: 'me@other.example',
    isDefault: false,
    workspace: true,
    hasChatScope: true,
  },
];

async function mount(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(React.createElement(GoogleChatAccountPicker));
  });
  return r;
}

const chip = (r: ReactTestRenderer, email: string) =>
  r.root.find(
    (n) =>
      (n.type as unknown) === 'TouchableOpacity' &&
      n.props.accessibilityLabel === `Use ${email} for Google Chat`,
  );

describe('mobile GoogleChatAccountPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getGoogleChatAccount as any).mockResolvedValue({
      account: { accountId: 'w', email: 'me@work.example' },
      boundEmail: 'me@work.example',
      candidates,
    });
  });

  it('offers Workspace accounts only and moves Chat after the user confirms', async () => {
    (api.setGoogleChatAccount as any).mockResolvedValue({
      account: { accountId: 'x', email: 'me@other.example' },
      boundEmail: 'me@other.example',
      candidates,
    });
    const r = await mount();
    expect(() => chip(r, 'me@gmail.com')).toThrow();
    expect(chip(r, 'me@work.example').props.accessibilityState).toEqual({ selected: true });

    await act(async () => chip(r, 'me@other.example').props.onPress());
    expect(alert).toHaveBeenCalledWith('Move Google Chat?', expect.any(String), expect.any(Array));
    expect(api.setGoogleChatAccount).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => buttons.find((b) => b.text === 'Move')!.onPress!());
    expect(api.setGoogleChatAccount).toHaveBeenCalledWith('x');
    expect(chip(r, 'me@other.example').props.accessibilityState).toEqual({ selected: true });
  });
});
