import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act, create } = TestRenderer;

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: 'FlatList',
  Linking: { openURL: vi.fn() },
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../context/SidebarContext', () => ({ SidebarContext: {} }));
vi.mock('../utils/api', () => ({ api: { requestPrReviewSession: vi.fn(), resolvePR: vi.fn() } }));
vi.mock('../components/PrDiffView', () => ({ default: () => null }));
vi.mock('../components/PrReviewSheet', () => ({ default: () => null }));
vi.mock('../components/PrCommentSheet', () => ({ default: () => null }));
vi.mock('../components/PrEditSheet', () => ({ default: () => null }));
vi.mock('../components/PrDismissSheet', () => ({ default: () => null }));

const { PrDetail } = await import('./PullRequestsScreen');
const { api } = await import('../utils/api');
const detail = {
  source: 'user-oauth',
  pr: { number: 42, state: 'open', title: 'Fix bug' },
  reviews: [],
  comments: [],
  checks: [],
};

describe('private GitHub review on mobile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the seeded review chat without invoking Resolve PR', async () => {
    vi.mocked(api.requestPrReviewSession).mockResolvedValue({
      sessionId: 'review-session',
      agentId: 'a1',
    });
    const onOpenReviewSession = vi.fn();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <PrDetail
          detail={detail}
          projectId="p1"
          reviewAgentId="a1"
          onOpenReviewSession={onOpenReviewSession}
        />,
      );
    });
    const button = tree!.root.findByProps({ accessibilityLabel: 'Request Agent Review' });
    expect(button.props.accessibilityHint).toContain('Nothing is pushed or posted');
    await act(async () => {
      await button.props.onPress();
    });
    expect(api.requestPrReviewSession).toHaveBeenCalledWith('p1', 42, 'a1');
    expect(onOpenReviewSession).toHaveBeenCalledWith('review-session', 'a1');
    expect(api.resolvePR).not.toHaveBeenCalled();
    await act(async () => {
      tree!.unmount();
    });
  });

  it('disables review when there is no interactive agent', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<PrDetail detail={detail} projectId="p1" />);
    });
    expect(
      tree!.root.findByProps({ accessibilityLabel: 'Request Agent Review' }).props.disabled,
    ).toBe(true);
    await act(async () => {
      tree!.unmount();
    });
  });

  it('shows an in-progress banner while an agent review is running', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <PrDetail
          detail={{ ...detail, pr: { ...detail.pr, agent_review_requested: true } }}
          projectId="p1"
        />,
      );
    });
    const banner = tree!.root.findByProps({ testID: 'pr-agent-review-in-progress-banner' });
    expect(banner.props.accessibilityLabel).toBe('Agent review in progress');
    await act(async () => {
      tree!.unmount();
    });
  });

  it('omits the banner when no agent review is running', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<PrDetail detail={detail} projectId="p1" />);
    });
    expect(
      tree!.root.findAllByProps({ testID: 'pr-agent-review-in-progress-banner' }),
    ).toHaveLength(0);
    await act(async () => {
      tree!.unmount();
    });
  });
});
