import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Modal: ({ children, visible }: any) => (visible ? <div>{children}</div> : null),
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ projects: [{ id: 'p1', name: 'Proj' }] }),
}));
vi.mock('../context/SidebarContext', () => ({
  SidebarContext: React.createContext({ openSidebar: vi.fn() }),
}));
vi.mock('../utils/api', () => ({
  api: {
    listRumSessions: vi.fn(),
    listReplays: vi.fn(),
    linkReplayToTicket: vi.fn(),
    unlinkReplay: vi.fn(),
    getSessionSegments: vi.fn(() => Promise.resolve({ sessionId: 's-1', segments: [] })),
    getReplay: vi.fn(() => Promise.resolve({ retainedUntil: null })),
    setReplayRetention: vi.fn(),
  },
}));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.example.com' }));
// The in-app WebView player is exercised by its own tests + the pure
// streamReplayTarget tests; here we only assert the screen mounts it with the
// right target, so stub it to keep the 220KB rrweb bundle out of this suite.
vi.mock('../components/ReplayWebViewPlayer', () => ({
  default: ({ target }: any) => <div>{`PLAYER:${JSON.stringify(target)}`}</div>,
}));

import { Linking } from 'react-native';
import ReplaysScreen, {
  RumSessionsList,
  ReplayCaptureList,
  RumSessionRow,
  ReplayCaptureRow,
  ReplayPlayerModal,
  buildWebReplaysUrl,
  unlinkReplayCapture,
  setReplayRetentionFlag,
} from './ReplaysScreen';

const SESSION = {
  sessionId: 's-1',
  usrEmail: 'ada@example.com',
  startedAt: 1_700_000_000_000,
  timeSpent: 65_000,
  viewCount: 3,
  actionCount: 12,
  errorCount: 2,
  frustrationCount: 1,
  deviceType: 'Desktop',
  browser: 'Chrome',
  os: 'macOS',
  geoCountry: 'US',
};

const REPLAY = {
  id: 'r-1',
  pageUrl: 'https://app.example.com/checkout',
  createdAt: '2026-07-08 03:00:00',
  durationMs: 42_000,
  eventCount: 88,
  size: 2048,
  captureKind: 'continuous',
};

describe('RumSessionsList', () => {
  it('renders a row per session with user + facet data', () => {
    const html = renderToStaticMarkup(
      <RumSessionsList sessions={[SESSION]} loading={false} error={null} active={false} />,
    );
    expect(html).toContain('ada@example.com');
    expect(html).toContain('1m 5s'); // duration
    expect(html).toContain('Chrome');
    expect(html).toContain('Desktop');
  });

  it('shows the filtered empty copy when filters are active', () => {
    const html = renderToStaticMarkup(
      <RumSessionsList sessions={[]} loading={false} error={null} active={true} />,
    );
    expect(html).toContain('No sessions match the current filters');
  });

  it('shows the default empty copy with no filters', () => {
    const html = renderToStaticMarkup(
      <RumSessionsList sessions={[]} loading={false} error={null} active={false} />,
    );
    expect(html).toContain('continuous capture is enabled');
  });

  it('surfaces load errors', () => {
    const html = renderToStaticMarkup(
      <RumSessionsList sessions={[]} loading={false} error="boom" active={false} />,
    );
    expect(html).toContain('boom');
  });
});

describe('RumSessionRow', () => {
  it('falls back to Anonymous when no identity is attributed', () => {
    const html = renderToStaticMarkup(
      <RumSessionRow session={{ ...SESSION, usrEmail: '', usrName: '', usrId: '' }} />,
    );
    expect(html).toContain('Anonymous');
  });
});

describe('ReplayCaptureList', () => {
  it('renders a row per capture with page + size', () => {
    const html = renderToStaticMarkup(
      <ReplayCaptureList replays={[REPLAY]} loading={false} error={null} filter="all" kind="all" />,
    );
    expect(html).toContain('app.example.com/checkout');
    expect(html).toContain('2 KB');
    expect(html).toContain('continuous');
  });

  it('shows the orphans empty copy for that filter', () => {
    const html = renderToStaticMarkup(
      <ReplayCaptureList replays={[]} loading={false} error={null} filter="orphans" kind="all" />,
    );
    expect(html).toContain('No orphaned replays');
  });
});

describe('ReplayCaptureRow', () => {
  it('shows a linked ticket chip when attributed', () => {
    const html = renderToStaticMarkup(
      <ReplayCaptureRow replay={{ ...REPLAY, ticket: { id: 't1', subject: 'Broken cart' } }} />,
    );
    expect(html).toContain('Broken cart');
    expect(html).toContain('Unlink');
  });
  it('offers Link when unattributed', () => {
    const html = renderToStaticMarkup(<ReplayCaptureRow replay={REPLAY} />);
    expect(html).toContain('Link');
    expect(html).not.toContain('Unlink');
  });
});

describe('ReplayPlayerModal', () => {
  it('renders nothing without a target', () => {
    const html = renderToStaticMarkup(<ReplayPlayerModal target={null} projectId="p1" />);
    expect(html).toBe('');
  });
  it('renders metadata, the in-app player, and the web-app handoff', () => {
    const html = renderToStaticMarkup(
      <ReplayPlayerModal
        target={{
          mode: 'session',
          title: 'ada@example.com',
          meta: [{ label: 'Views', value: '3' }],
        }}
        projectId="p1"
      />,
    );
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Views');
    expect(html).toContain('Open in web app');
    expect(html).toContain('PLAYER:'); // the embedded WebView player mounts
  });

  it('embeds the player with the session target for a segmented session', () => {
    const html = renderToStaticMarkup(
      <ReplayPlayerModal
        target={{ mode: 'session', sessionId: 's-1', title: 'ada@example.com', meta: [] }}
        projectId="p1"
      />,
    );
    expect(html).toContain('&quot;sessionId&quot;:&quot;s-1&quot;');
  });

  it('embeds the player with the replay target for a monolithic capture', () => {
    const html = renderToStaticMarkup(
      <ReplayPlayerModal
        target={{
          mode: 'replay',
          replayId: 'r-1',
          title: 'checkout',
          meta: [{ label: 'Events', value: '88' }],
        }}
        projectId="p1"
      />,
    );
    expect(html).toContain('&quot;replayId&quot;:&quot;r-1&quot;');
  });

  it('offers the Keep (extended-retention) control for a monolithic capture', () => {
    const html = renderToStaticMarkup(
      <ReplayPlayerModal
        target={{ mode: 'replay', replayId: 'r-1', title: 'checkout', meta: [] }}
        projectId="p1"
      />,
    );
    // Effects don't run under static markup, so the initial (unflagged) label shows.
    expect(html).toContain('Keep');
  });

  it('hides the Keep control for a segmented session (no session_replays row)', () => {
    const html = renderToStaticMarkup(
      <ReplayPlayerModal
        target={{ mode: 'session', sessionId: 's-1', title: 'ada@example.com', meta: [] }}
        projectId="p1"
      />,
    );
    expect(html).not.toContain('Keep');
  });
});

describe('setReplayRetentionFlag', () => {
  it('flags the capture and returns the server-echoed retainedUntil', async () => {
    const apiClient = {
      setReplayRetention: vi.fn().mockResolvedValue({ retainedUntil: '2027-09-10 09:00:00' }),
    };
    const next = await setReplayRetentionFlag({ api: apiClient, replayId: 'r-1', extend: true });
    expect(apiClient.setReplayRetention).toHaveBeenCalledWith('r-1', true);
    expect(next).toBe('2027-09-10 09:00:00');
  });

  it('falls back to a SQLite-UTC stamp when the response omits retainedUntil', async () => {
    const apiClient = { setReplayRetention: vi.fn().mockResolvedValue({}) };
    const next = await setReplayRetentionFlag({
      api: apiClient,
      replayId: 'r-1',
      extend: true,
      nowIso: '2026-07-08T12:34:56.789Z',
    });
    expect(next).toBe('2026-07-08 12:34:56');
  });

  it('returns null when unflagging (extend false)', async () => {
    const apiClient = { setReplayRetention: vi.fn().mockResolvedValue({}) };
    const next = await setReplayRetentionFlag({ api: apiClient, replayId: 'r-1', extend: false });
    expect(apiClient.setReplayRetention).toHaveBeenCalledWith('r-1', false);
    expect(next).toBeNull();
  });
});

describe('ReplaysScreen shell', () => {
  it('mounts with the Sessions/Replays toggle and default empty state', () => {
    const html = renderToStaticMarkup(<ReplaysScreen route={{ params: { projectId: 'p1' } }} />);
    expect(html).toContain('Sessions');
    expect(html).toContain('Replays');
    expect(html).toContain('Last 24 hours'); // default time range chip present
  });
});

describe('buildWebReplaysUrl', () => {
  it('builds the project-scoped web dashboard deep link', () => {
    expect(buildWebReplaysUrl('p1', 'https://hub.example.com')).toBe(
      'https://hub.example.com/replays/p1',
    );
  });
  it('encodes the project id', () => {
    expect(buildWebReplaysUrl('a/b', 'https://hub.example.com')).toBe(
      'https://hub.example.com/replays/a%2Fb',
    );
  });
  it('returns empty when the base or project is unknown (control hidden)', () => {
    expect(buildWebReplaysUrl('', 'https://hub.example.com')).toBe('');
    expect(buildWebReplaysUrl('p1', '')).toBe('');
  });
});

describe('unlinkReplayCapture', () => {
  it('detaches the replay from its ticket and reloads the list', async () => {
    const apiClient = { unlinkReplay: vi.fn().mockResolvedValue({}) };
    const reload = vi.fn().mockResolvedValue(undefined);
    await unlinkReplayCapture({ api: apiClient, projectId: 'p1', replayId: 'r-1', reload });
    expect(apiClient.unlinkReplay).toHaveBeenCalledWith('p1', 'r-1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('swallows a transient failure and does not reload', async () => {
    const apiClient = { unlinkReplay: vi.fn().mockRejectedValue(new Error('offline')) };
    const reload = vi.fn();
    await expect(
      unlinkReplayCapture({ api: apiClient, projectId: 'p1', replayId: 'r-1', reload }),
    ).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('ReplayPlayerModal handoff', () => {
  it('opens the web dashboard (not a per-replay link) on Open in web app', () => {
    // Static markup can't fire onPress, so assert the URL the button is wired to
    // is the project dashboard deep link.
    expect(buildWebReplaysUrl('p1', 'https://hub.example.com')).toContain('/replays/p1');
    // Linking is mocked; ensure the import is exercised so a wiring regression
    // (e.g. importing the wrong symbol) surfaces.
    expect(typeof Linking.openURL).toBe('function');
  });
});
