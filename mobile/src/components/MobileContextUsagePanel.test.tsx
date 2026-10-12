import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({ X: 'X' }));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
const getSessionContextUsage = vi.fn();
vi.mock('../utils/api', () => ({ api: { getSessionContextUsage } }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: MobileContextUsagePanel } = await import('./MobileContextUsagePanel');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

function text(renderer: ReactTestRenderer, testID: string): string {
  const node = renderer.root.findByProps({ testID });
  return ([] as unknown[]).concat(node.props.children).join('');
}

describe('MobileContextUsagePanel', () => {
  it('renders the breakdown and closes', async () => {
    getSessionContextUsage.mockResolvedValue({
      sessionId: 's1',
      engine: 'claude-code',
      model: 'opus',
      source: 'reported',
      totalTokens: 146_000,
      contextWindow: 200_000,
      percent: 73,
      categories: [
        { key: 'system', label: 'System prompt', tokens: 1700 },
        { key: 'wiki', label: 'Wiki & retrieval', tokens: 0 },
        { key: 'conversation', label: 'Conversation', tokens: 144_300 },
      ],
      updatedAt: null,
    });
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MobileContextUsagePanel sessionId="s1" onClose={onClose} pollMs={60_000} />,
      );
    });
    expect(getSessionContextUsage).toHaveBeenCalledWith('s1');
    expect(text(renderer, 'mobile-context-usage-percent')).toBe('73% Full');
    expect(text(renderer, 'mobile-context-usage-total')).toBe('146K / 200K Tokens');
    expect(
      renderer.root.findAllByProps({ testID: 'mobile-context-usage-row-system' }),
    ).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: 'mobile-context-usage-row-wiki' })).toHaveLength(
      0,
    );
    act(() => renderer.root.findByProps({ testID: 'mobile-context-usage-close' }).props.onPress());
    expect(onClose).toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
