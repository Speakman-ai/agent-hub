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
vi.mock('../utils/api', () => ({
  api: {
    getPullPreviewState: vi.fn(),
    startPullPreview: vi.fn(),
    stopPullPreview: vi.fn(),
  },
}));
vi.mock('../components/PrDiffView', () => ({ default: () => null }));
vi.mock('../components/PrReviewSheet', () => ({ default: () => null }));
vi.mock('../components/PrCommentSheet', () => ({ default: () => null }));
vi.mock('../components/PrEditSheet', () => ({ default: () => null }));
vi.mock('../components/PrDismissSheet', () => ({ default: () => null }));

const { PrDetail } = await import('./PullRequestsScreen');
const { api } = await import('../utils/api');

const detail = (over: Record<string, unknown> = {}) => ({
  source: 'agenthub',
  preview_available: true,
  pr: { number: 42, state: 'open', title: 'Fix bug', html_url: '/projects/p1/pulls/42' },
  reviews: [],
  comments: [],
  checks: [],
  ...over,
});

function textContent(tree: ReturnType<typeof create>): string {
  return tree.root
    .findAllByType('Text' as any)
    .map((n) => [].concat(n.props.children).join(''))
    .join('\n');
}

async function render(d: any) {
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<PrDetail detail={d} projectId="p1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree!;
}

describe('PR environment panel on mobile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a ready environment URL and its log tail from the PR-keyed state', async () => {
    vi.mocked(api.getPullPreviewState).mockResolvedValue({
      environment: {
        status: 'ready',
        url: 'https://pr-42.example/',
        logTail: ['compose up', 'healthy'],
      },
    });
    const tree = await render(detail());
    expect(api.getPullPreviewState).toHaveBeenCalledWith('p1', 42);
    const text = textContent(tree);
    expect(text).toContain('https://pr-42.example/');
    expect(text).toContain('healthy');
    expect(tree.root.findByProps({ accessibilityLabel: 'Tear down environment' })).toBeTruthy();
    expect(api.startPullPreview).not.toHaveBeenCalled();
  });

  it('shows the queued status', async () => {
    vi.mocked(api.getPullPreviewState).mockResolvedValue({
      environment: { status: 'queued', logTail: [] },
    });
    const tree = await render(detail());
    expect(textContent(tree)).toMatch(/Queued/);
  });

  it('starts an environment from idle', async () => {
    vi.mocked(api.getPullPreviewState).mockResolvedValue({ environment: null });
    vi.mocked(api.startPullPreview).mockResolvedValue({ ok: true });
    const tree = await render(detail());
    const start = tree.root.findByProps({ accessibilityLabel: 'Start environment' });
    await act(async () => {
      await start.props.onPress();
    });
    expect(api.startPullPreview).toHaveBeenCalledWith('p1', 42, { reason: 'PR #42 environment' });
  });

  it('renders no panel when the head has no preview block', async () => {
    const tree = await render(detail({ preview_available: false }));
    expect(tree.root.findAllByProps({ accessibilityLabel: 'PR environment' })).toHaveLength(0);
    expect(api.getPullPreviewState).not.toHaveBeenCalled();
  });

  it('re-reads the environment when the PR head moves, replacing a stale ready URL', async () => {
    vi.mocked(api.getPullPreviewState)
      .mockResolvedValueOnce({
        environment: { status: 'ready', url: 'https://pr-42-a.example/', logTail: [] },
      })
      .mockResolvedValue({ environment: { status: 'queued', logTail: [] } });
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<PrDetail detail={detail({ headSha: 'a'.repeat(40) })} projectId="p1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(textContent(tree!)).toContain('https://pr-42-a.example/');

    await act(async () => {
      tree!.update(<PrDetail detail={detail({ headSha: 'b'.repeat(40) })} projectId="p1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getPullPreviewState).toHaveBeenCalledTimes(2);
    expect(textContent(tree!)).not.toContain('https://pr-42-a.example/');
    expect(textContent(tree!)).toMatch(/Queued/);
  });

  it('a failed state read does not stop polling: the next poll shows the environment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.getPullPreviewState)
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValue({
          environment: { status: 'ready', url: 'https://pr-42.example/', logTail: [] },
        });
      const tree = await render(detail());
      expect(api.getPullPreviewState).toHaveBeenCalledTimes(1);
      expect(textContent(tree)).not.toContain('https://pr-42.example/');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.getPullPreviewState).toHaveBeenCalledTimes(2);
      expect(textContent(tree)).toContain('https://pr-42.example/');
      await act(async () => {
        tree.unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an environment whose teardown failed after the head dropped preview offers Retry teardown', async () => {
    vi.mocked(api.getPullPreviewState).mockResolvedValue({
      environment: {
        status: 'stopped',
        stopReason: 'no_preview_config',
        cleanupPending: true,
        error: 'Teardown failed: docker daemon down',
        logTail: [],
      },
    });
    vi.mocked(api.stopPullPreview).mockResolvedValue({ ok: true });
    const tree = await render(detail());
    expect(textContent(tree)).toMatch(/Teardown did not finish/);
    const retry = tree.root.findByProps({ accessibilityLabel: 'Retry teardown' });
    await act(async () => {
      await retry.props.onPress();
    });
    expect(api.stopPullPreview).toHaveBeenCalledWith('p1', 42);
    await act(async () => {
      tree.unmount();
    });
  });

  it('a merged PR whose teardown failed shows the error, logs, and Retry teardown, but no Start', async () => {
    vi.mocked(api.getPullPreviewState).mockResolvedValue({
      environment: {
        status: 'stopped',
        stopReason: 'merged',
        cleanupPending: true,
        error: 'Teardown failed: docker daemon down',
        logTail: ['error: daemon unreachable'],
      },
    });
    const tree = await render(
      detail({
        pr: {
          number: 42,
          state: 'closed',
          merged_at: '2026-10-12T00:00:00Z',
          title: 'Fix bug',
          html_url: '/projects/p1/pulls/42',
        },
      }),
    );
    const text = textContent(tree);
    expect(text).toMatch(/docker daemon down/);
    expect(text).toContain('daemon unreachable');
    expect(tree.root.findByProps({ accessibilityLabel: 'Retry teardown' })).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Start environment' })).toHaveLength(0);
    await act(async () => {
      tree.unmount();
    });
  });
});
