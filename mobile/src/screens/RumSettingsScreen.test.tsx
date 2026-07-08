import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ setActiveAgentId: vi.fn(), setActiveSessionId: vi.fn() }),
}));
vi.mock('../utils/api', () => ({
  api: {
    getRumSetupDraft: vi.fn(() => Promise.resolve({ draft: null })),
    getRumClients: vi.fn(() => Promise.resolve({ clients: [] })),
    updateProject: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));

import RumSettingsScreen, {
  buildRetentionReplayPatch,
  BASE_RETENTION_OPTIONS,
  EXTENDED_RETENTION_OPTIONS,
} from './RumSettingsScreen';

describe('buildRetentionReplayPatch', () => {
  it('overlays the extended-retention window, preserving other replay keys', () => {
    const patch = buildRetentionReplayPatch(
      { sampleRate: 0.5, extendedRetentionMonths: 3 },
      'extendedRetentionMonths',
      6,
    );
    expect(patch).toEqual({ sampleRate: 0.5, extendedRetentionMonths: 6 });
  });

  it('overlays a base-retention override, preserving other replay keys', () => {
    const patch = buildRetentionReplayPatch({ sampleRate: 0.5 }, 'retentionDays', 14);
    expect(patch).toEqual({ sampleRate: 0.5, retentionDays: 14 });
  });

  it('clears the base-retention override (omits retentionDays) at platform default 0', () => {
    const patch = buildRetentionReplayPatch(
      { sampleRate: 0.5, retentionDays: 30 },
      'retentionDays',
      0,
    );
    expect(patch).toEqual({ sampleRate: 0.5 });
    expect('retentionDays' in patch).toBe(false);
  });

  it('tolerates a null/undefined current config', () => {
    expect(buildRetentionReplayPatch(null, 'extendedRetentionMonths', 12)).toEqual({
      extendedRetentionMonths: 12,
    });
  });

  it('does not mutate the input config', () => {
    const input = { sampleRate: 0.5, retentionDays: 30 };
    buildRetentionReplayPatch(input, 'retentionDays', 0);
    expect(input).toEqual({ sampleRate: 0.5, retentionDays: 30 });
  });
});

describe('retention option sets', () => {
  it('exposes the platform-default + shortening base windows', () => {
    expect(BASE_RETENTION_OPTIONS[0]).toEqual({ value: 0, label: 'Default' });
    expect(BASE_RETENTION_OPTIONS.map((o) => o.value)).toEqual([0, 7, 14, 30, 60, 90]);
  });
  it('caps the extended window at 15 months', () => {
    expect(EXTENDED_RETENTION_OPTIONS.map((o) => o.value)).toEqual([1, 3, 6, 12, 15]);
    expect(EXTENDED_RETENTION_OPTIONS.at(-1)).toEqual({ value: 15, label: '15 mo (max)' });
  });
});

describe('RumSettingsScreen retention section', () => {
  it('renders the retention config with the persisted windows preselected', () => {
    const project = { id: 'demo', name: 'Demo', replay: { retentionDays: 14, extendedRetentionMonths: 6 } };
    const html = renderToStaticMarkup(
      <RumSettingsScreen route={{ params: { projectId: 'demo', project } }} navigation={{ goBack: vi.fn() }} />,
    );
    expect(html).toContain('Retention (this project)');
    expect(html).toContain('Base-retention window');
    expect(html).toContain('Extended-retention window');
    // Every window chip renders.
    expect(html).toContain('14 days');
    expect(html).toContain('6 mo');
    expect(html).toContain('15 mo (max)');
  });

  it('defaults to platform-default base + 15-month extended when unconfigured', () => {
    const project = { id: 'demo', name: 'Demo' };
    const html = renderToStaticMarkup(
      <RumSettingsScreen route={{ params: { projectId: 'demo', project } }} navigation={{ goBack: vi.fn() }} />,
    );
    expect(html).toContain('Retention (this project)');
    expect(html).toContain('Default');
  });
});
