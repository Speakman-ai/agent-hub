import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Modal: ({ children }: any) => <div>{children}</div>,
  RefreshControl: 'RefreshControl',
  ScrollView: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
  StyleSheet: { create: (styles: any) => styles },
  Switch: 'Switch',
  Text: ({ children, testID }: any) => <span data-testid={testID}>{children}</span>,
  TextInput: 'TextInput',
  TouchableOpacity: ({ children, testID, accessibilityState }: any) => (
    <button data-testid={testID} aria-selected={accessibilityState?.selected}>
      {children}
    </button>
  ),
  View: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    projects: [{ id: 'p1', name: 'Proj' }],
    subscribeQaUpdates: () => () => {},
    setActiveAgentId: vi.fn(),
    setActiveSessionId: vi.fn(),
  }),
}));
vi.mock('../context/SidebarContext', () => ({
  SidebarContext: React.createContext({ openSidebar: vi.fn() }),
}));
vi.mock('../utils/api', () => ({ api: { listQaPlans: vi.fn(() => new Promise(() => {})) } }));
vi.mock('../components/SessionArtifactViewerModal', () => ({ default: () => null }));

import QaScreen, { QaPlanItem, QaStatusTabs } from './QaScreen';

const plan = {
  id: 'plan-1',
  projectId: 'p1',
  title: 'Checkout flow',
  goal: '',
  targetUrl: 'https://staging.example.com/checkout',
  epicId: 'e1',
  cardId: null,
  status: 'in_progress' as const,
  approved: true,
  signedOffAt: null,
  createdAt: '',
  updatedAt: '',
  summary: {
    caseCount: 2,
    epic: { id: 'e1', name: 'Payments' },
    card: null,
    latestRun: {
      id: 'r1',
      iteration: 1,
      status: 'failed' as const,
      scope: 'full' as const,
      finishedAt: null,
      verdicts: { pass: 1, fail: 1, needs_change: 0, blocked: 0 },
    },
  },
};

describe('QaScreen', () => {
  it('renders the status tabs with counts and marks the active one', () => {
    const html = renderToStaticMarkup(
      <QaStatusTabs
        tab="in_progress"
        counts={{ new: 3, in_progress: 1, done: 0 }}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('data-testid="qa-tab-new"');
    expect(html).toMatch(/data-testid="qa-tab-in_progress" aria-selected="true"/);
    expect(html).toContain('New');
    expect(html).toContain('In progress');
    expect(html).toContain('Done');
  });

  it('renders a plan with its host, latest-run verdicts and epic chip', () => {
    const html = renderToStaticMarkup(
      <QaPlanItem plan={plan} variant="card" onOpenPlan={() => {}} onOpenEpic={() => {}} />,
    );
    expect(html).toContain('qa-plan-card-plan-1');
    expect(html).toContain('Checkout flow');
    expect(html).toContain('staging.example.com');
    expect(html).toContain('<span>1 fail</span>');
    expect(html).toContain('Run 1 failed');
    expect(html).toContain('Payments');
  });

  it('mounts with the New plan button and the list/board toggle', () => {
    const html = renderToStaticMarkup(<QaScreen route={{ params: { projectId: 'p1' } }} />);
    expect(html).toContain('data-testid="qa-new-plan"');
    expect(html).toContain('data-testid="qa-view-list"');
    expect(html).toContain('data-testid="qa-view-board"');
    expect(html).toContain('data-testid="qa-tab-new"');
  });
});
