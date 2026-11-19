import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  orgs: null as any,
  handleSwitchOrg: vi.fn(),
}));

vi.mock('react-native', () => ({
  Pressable: nativeHost('Pressable'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('./HubIcon', () => ({ default: nativeHost('HubIcon') }));
vi.mock('../hooks/useGoogleChatAvailable', () => ({ useGoogleChatAvailable: () => false }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ handleSwitchOrg: testState.handleSwitchOrg }),
}));
vi.mock('../utils/orgs', () => ({
  getOrgs: () => testState.orgs,
  getActiveOrg: () =>
    testState.orgs?.orgs.find((o: any) => o.id === testState.orgs.activeOrgId) ?? null,
}));

const { default: SimpleHomeNav } = await import('./SimpleHomeNav');

const server = (id: string, name: string, color: string) => ({
  id,
  name,
  color,
  mode: 'remote',
  remoteUrl: `https://${id}.example.com`,
});

function render() {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(<SimpleHomeNav active="chats" onSelect={vi.fn()} />);
  });
  return renderer;
}

/** Top-level testIDs in render order, so placement can be asserted. */
function topLevelTestIds(renderer: ReactTestRenderer): string[] {
  const tree = renderer.toJSON();
  const nodes = Array.isArray(tree) ? tree : tree ? [tree] : [];
  return nodes.map((n: any) => n.props.testID);
}

describe('SimpleHomeNav server picker', () => {
  beforeEach(() => {
    testState.handleSwitchOrg.mockReset().mockResolvedValue(undefined);
  });

  it('renders nothing for the picker with a single saved server', () => {
    testState.orgs = { activeOrgId: 'a', orgs: [server('a', 'Acme', '#111')] };
    const renderer = render();
    expect(renderer.root.findAllByProps({ testID: 'server-picker' })).toHaveLength(0);
    expect(topLevelTestIds(renderer)).toEqual(['simple-home-nav']);
  });

  it('renders the active server above the page selector with two or more', () => {
    testState.orgs = {
      activeOrgId: 'b',
      orgs: [server('a', 'Acme', '#111'), server('b', 'Beta', '#222')],
    };
    const renderer = render();
    expect(topLevelTestIds(renderer)).toEqual(['server-picker', 'simple-home-nav']);
    const toggle = renderer.root.findByProps({ testID: 'server-picker-toggle' });
    expect(toggle.props.accessibilityLabel).toBe('Server: Beta');
  });

  it('switches through handleSwitchOrg when another server is chosen', async () => {
    testState.orgs = {
      activeOrgId: 'a',
      orgs: [server('a', 'Acme', '#111'), server('b', 'Beta', '#222')],
    };
    const renderer = render();
    TestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'server-picker-toggle' }).props.onPress(),
    );
    await TestRenderer.act(async () => {
      await renderer.root.findByProps({ testID: 'server-picker-item-b' }).props.onPress();
    });
    expect(testState.handleSwitchOrg).toHaveBeenCalledWith('b');
    expect(renderer.root.findAllByProps({ testID: 'server-picker-item-b' })).toHaveLength(0);
  });

  it('does not switch when the active server is chosen', async () => {
    testState.orgs = {
      activeOrgId: 'a',
      orgs: [server('a', 'Acme', '#111'), server('b', 'Beta', '#222')],
    };
    const renderer = render();
    TestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'server-picker-toggle' }).props.onPress(),
    );
    await TestRenderer.act(async () => {
      await renderer.root.findByProps({ testID: 'server-picker-item-a' }).props.onPress();
    });
    expect(testState.handleSwitchOrg).not.toHaveBeenCalled();
  });
});
