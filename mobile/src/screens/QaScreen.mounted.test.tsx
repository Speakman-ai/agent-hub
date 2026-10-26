/**
 * QaScreen mounted with react-test-renderer: switching project while a plan
 * detail is open returns to the new project's list, or opens the plan the
 * navigation named in that project.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: () => null }));
vi.mock('../components/NewQaPlanModal', () => ({ default: () => null }));
vi.mock('../components/QaPlanDetailView', () => ({
  default: () => null,
  QaLinkChips: () => null,
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    projects: [],
    subscribeQaUpdates: () => () => {},
    setActiveAgentId: () => {},
    setActiveSessionId: () => {},
  }),
}));
vi.mock('../utils/api', () => ({
  api: {
    listQaPlans: vi.fn(async () => ({ plans: [], counts: { new: 0, in_progress: 0, done: 0 } })),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: QaScreen } = await import('./QaScreen');
process.env.NODE_ENV = originalNodeEnv;

const navigation = { navigate: vi.fn(), setParams: vi.fn() };
const render = async (tree: any, params: any) => {
  await act(async () => {
    tree.update(<QaScreen route={{ params }} navigation={navigation} />);
  });
};
// The detail stub's props say which plan is open; query the tree rather than
// serializing it (dev-mode element props are circular).
const openDetail = (tree: any) => {
  const [detail] = tree.root.findAll(
    (n: any) => typeof n.props?.planId === 'string' && 'notice' in n.props,
  );
  return detail ? `${detail.props.projectId}:${detail.props.planId}` : null;
};
const hasNewPlanButton = (tree: any) =>
  tree.root.findAll((n: any) => n.props?.testID === 'qa-new-plan').length > 0;

describe('QaScreen project switch', () => {
  it('drops the old project plan, and honours a plan named for the new project', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(
        <QaScreen
          route={{ params: { projectId: 'p1', planId: 'plan-a' } }}
          navigation={navigation}
        />,
      );
    });
    expect(openDetail(tree)).toBe('p1:plan-a');

    await render(tree, { projectId: 'p2' });
    expect(openDetail(tree)).toBeNull();
    expect(hasNewPlanButton(tree)).toBe(true);

    await render(tree, { projectId: 'p1', planId: 'plan-b' });
    expect(openDetail(tree)).toBe('p1:plan-b');
  });
});
