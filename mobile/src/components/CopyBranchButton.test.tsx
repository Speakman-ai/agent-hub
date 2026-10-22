import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (s: any) => s },
  TouchableOpacity: 'TouchableOpacity',
}));
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', Check: 'Check' }));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
const copyToClipboard = vi.fn();
vi.mock('../utils/clipboard', () => ({ copyToClipboard }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: CopyBranchButton } = await import('./CopyBranchButton');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

function button(r: ReactTestRenderer) {
  return r.root.findByProps({ testID: 'copy-branch-button' });
}

describe('CopyBranchButton (mobile)', () => {
  beforeEach(() => copyToClipboard.mockReset());

  it('copies the branch and flips to the copied state', async () => {
    copyToClipboard.mockResolvedValue(true);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<CopyBranchButton branch="feature/foo" />);
    });
    await act(async () => {
      await button(r).props.onPress();
    });
    expect(copyToClipboard).toHaveBeenCalledWith('feature/foo');
    expect(button(r).props.accessibilityLabel).toBe('Copied branch name');
    r.unmount();
  });

  it('stays idle when the copy fails', async () => {
    copyToClipboard.mockResolvedValue(false);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<CopyBranchButton branch="x" />);
    });
    await act(async () => {
      await button(r).props.onPress();
    });
    expect(button(r).props.accessibilityLabel).toBe('Copy branch name x');
    r.unmount();
  });

  it('renders nothing without a branch', async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<CopyBranchButton branch="" />);
    });
    expect(r.toJSON()).toBeNull();
  });
});
