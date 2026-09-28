import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

const alertMock = vi.fn();
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: (...args: unknown[]) => alertMock(...args) },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));
vi.mock('../theme/colors', () => ({ colors: { red400: '#f87171' } }));
vi.mock('../utils/api', () => ({
  api: { getSessionChanges: vi.fn(), discardSessionChanges: vi.fn() },
}));

const { api } = await import('../utils/api');
const { default: DiscardChangesButton } = await import('./DiscardChangesButton');

type AlertButton = { text: string; style?: string; onPress?: () => void };

async function press(renderer: ReactTestRenderer) {
  const btn = renderer.root.findByProps({ testID: 'discard-changes-button' });
  await act(async () => {
    btn.props.onPress();
  });
}

describe('mobile DiscardChangesButton', () => {
  beforeEach(() => {
    alertMock.mockReset();
    vi.mocked(api.getSessionChanges)
      .mockReset()
      .mockResolvedValue({ files: [{ additions: 4, deletions: 1 }], truncated: false });
    vi.mocked(api.discardSessionChanges)
      .mockReset()
      .mockResolvedValue({ ok: true, discardedAt: '2026-09-28 17:00:00' });
  });

  it('confirms with the diff size, then discards and reports the result', async () => {
    const onDiscarded = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DiscardChangesButton sessionId="s1" onDiscarded={onDiscarded} />,
      );
    });
    await press(renderer);

    expect(alertMock).toHaveBeenCalledTimes(1);
    const [, message, buttons] = alertMock.mock.calls[0] as [string, string, AlertButton[]];
    expect(message).toContain('1 file (+4 -1)');
    expect(message).toContain('cannot be undone');
    expect(api.discardSessionChanges).not.toHaveBeenCalled();

    const confirm = buttons.find((b) => b.text === 'Discard');
    expect(confirm?.style).toBe('destructive');
    await act(async () => {
      confirm?.onPress?.();
    });
    expect(api.discardSessionChanges).toHaveBeenCalledWith('s1');
    expect(onDiscarded).toHaveBeenCalledWith({
      sessionId: 's1',
      discardedAt: '2026-09-28 17:00:00',
    });
  });

  it('cancel leaves the session untouched', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<DiscardChangesButton sessionId="s1" />);
    });
    await press(renderer);
    const buttons = alertMock.mock.calls[0][2] as AlertButton[];
    expect(buttons.find((b) => b.text === 'Cancel')?.onPress).toBeUndefined();
    expect(api.discardSessionChanges).not.toHaveBeenCalled();
  });

  it('reports a server refusal via onError', async () => {
    vi.mocked(api.discardSessionChanges).mockRejectedValue(new Error('A turn is running'));
    const onError = vi.fn();
    const onDiscarded = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DiscardChangesButton sessionId="s1" onError={onError} onDiscarded={onDiscarded} />,
      );
    });
    await press(renderer);
    const buttons = alertMock.mock.calls[0][2] as AlertButton[];
    await act(async () => {
      buttons.find((b) => b.text === 'Discard')?.onPress?.();
    });
    expect(onError).toHaveBeenCalledWith('A turn is running');
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('is disabled and never prompts when blocked', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DiscardChangesButton sessionId="s1" blockedReason="Stop Finalize before discarding" />,
      );
    });
    const btn = renderer.root.findByProps({ testID: 'discard-changes-button' });
    expect(btn.props.disabled).toBe(true);
    await press(renderer);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
