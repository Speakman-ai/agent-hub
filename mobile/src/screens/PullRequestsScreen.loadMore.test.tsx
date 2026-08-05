/**
 * The PR list's "Load more" footer.
 *
 * Regression guard: a failed page fetch used to clear `hasMore`, which removed
 * the footer entirely — one dropped request and the rest of the list was
 * unreachable until the user pulled to refresh or switched tabs. The footer now
 * survives the failure and turns into a retry.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: () => <div>SPINNER</div>,
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Modal: ({ children, visible }: any) => (visible ? <div>{children}</div> : null),
  RefreshControl: () => null,
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../context/SidebarContext', () => ({
  SidebarContext: React.createContext({ openSidebar: vi.fn() }),
}));
vi.mock('../utils/api', () => ({ api: { getProjectPulls: vi.fn() } }));
vi.mock('../components/PrDiffView', () => ({ default: () => null }));
vi.mock('../components/PrReviewSheet', () => ({ default: () => null }));
vi.mock('../components/PrCommentSheet', () => ({ default: () => null }));
vi.mock('../components/PrEditSheet', () => ({ default: () => null }));

import { LoadMoreFooter } from './PullRequestsScreen';

describe('LoadMoreFooter', () => {
  it('renders nothing when there is no further page', () => {
    expect(renderToStaticMarkup(<LoadMoreFooter hasMore={false} />)).toBe('');
  });

  it('offers Load more when another page exists', () => {
    const html = renderToStaticMarkup(<LoadMoreFooter hasMore onPress={vi.fn()} />);
    expect(html).toContain('Load more');
    expect(html).not.toContain('SPINNER');
  });

  it('shows a spinner instead of the label while fetching', () => {
    const html = renderToStaticMarkup(<LoadMoreFooter hasMore loading onPress={vi.fn()} />);
    expect(html).toContain('SPINNER');
    expect(html).not.toContain('Load more');
  });

  it('keeps the footer as a retry after a failed page fetch', () => {
    const html = renderToStaticMarkup(
      <LoadMoreFooter hasMore error="Network request failed" onPress={vi.fn()} />,
    );
    expect(html).toContain('Network request failed');
    expect(html).toContain('Tap to retry');
  });
});
