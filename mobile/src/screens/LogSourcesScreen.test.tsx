import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the tree without a native runtime (mobile test env is `node`, no RN
// testing-library). Matches the PromoteTodoModal / RumSettingsScreen pattern.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));
vi.mock('../utils/api', () => ({
  api: {
    getLogSources: vi.fn(() => Promise.resolve({ sources: [] })),
    getLogsMetrics: vi.fn(() => Promise.resolve({ storage: {} })),
    rotateLogSource: vi.fn(() => Promise.resolve({})),
    revokeLogSource: vi.fn(() => Promise.resolve({})),
    deleteLogSource: vi.fn(() => Promise.resolve({})),
  },
}));

import {
  formatLastIngest,
  formatBytes,
  buildConfirm,
  FreshTokenReveal,
} from './LogSourcesScreen';

describe('formatLastIngest', () => {
  it('returns "no logs yet" for falsy input', () => {
    expect(formatLastIngest(null)).toBe('no logs yet');
    expect(formatLastIngest(undefined)).toBe('no logs yet');
    expect(formatLastIngest(0)).toBe('no logs yet');
  });

  it('formats a recent epoch-ms timestamp as a relative "last log …" label', () => {
    expect(formatLastIngest(Date.now() - 5000)).toMatch(/^last log /);
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5 GB');
  });
});

describe('FreshTokenReveal — one-time reveal state', () => {
  it('renders nothing when there is no token', () => {
    expect(FreshTokenReveal({ token: null, label: 'x', onDismiss: () => {} })).toBeNull();
  });

  it('shows the plaintext token and a "shown once" warning', () => {
    const html = renderToStaticMarkup(
      <FreshTokenReveal token="ahlog_PLAINTEXT" label="prod-api" onDismiss={() => {}} />,
    );
    expect(html).toContain('ahlog_PLAINTEXT');
    expect(html).toContain('shown once');
    expect(html).toContain('prod-api');
  });
});

describe('buildConfirm — destructive confirmation state', () => {
  it('offers a non-destructive Cancel and a destructive confirm button', () => {
    const onConfirm = vi.fn();
    const c = buildConfirm({
      title: 'Revoke token',
      message: 'Are you sure?',
      confirmLabel: 'Revoke',
      onConfirm,
    });
    expect(c.title).toBe('Revoke token');
    expect(c.buttons).toHaveLength(2);
    const [cancel, confirm] = c.buttons;
    expect(cancel).toMatchObject({ text: 'Cancel', style: 'cancel' });
    expect(cancel.onPress).toBeUndefined();
    expect(confirm).toMatchObject({ text: 'Revoke', style: 'destructive' });
  });

  it('runs the action only when the destructive button is pressed, not on cancel', () => {
    const onConfirm = vi.fn();
    const c = buildConfirm({
      title: 'Delete source',
      message: 'Permanent.',
      confirmLabel: 'Delete',
      onConfirm,
    });
    // Simulate tapping Cancel — nothing runs.
    expect(onConfirm).not.toHaveBeenCalled();
    // Simulate tapping the destructive button.
    c.buttons[1].onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
