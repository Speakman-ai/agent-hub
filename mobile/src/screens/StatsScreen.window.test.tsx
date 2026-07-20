import { describe, expect, it, vi } from 'vitest';

// StatsScreen pulls in react-native / safe-area / the shared header, none of
// which run under the node test env. Mock them to plain hosts so we can import
// the pure window-label helper (same approach as TodosScreen.test.tsx).
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));
vi.mock('../utils/api', () => ({ api: { getProjectStats: vi.fn() } }));

import { formatStatsWindow } from './StatsScreen';

describe('StatsScreen formatStatsWindow', () => {
  it('labels a daily window with a day-level date range', () => {
    const buckets = [
      { start: '2026-06-21', label: '2026-06-21' },
      { start: '2026-07-20', label: '2026-07-20' },
    ];
    expect(formatStatsWindow('day', buckets)).toBe('2 days · Jun 21, 2026 to Jul 20, 2026');
  });

  it('labels a monthly window with month/year endpoints across a year boundary', () => {
    const buckets = [
      { start: '2025-08-01', label: '2025-08' },
      { start: '2026-07-01', label: '2026-07' },
    ];
    expect(formatStatsWindow('month', buckets)).toBe('2 months · Aug 2025 to Jul 2026');
  });

  it('collapses to a single endpoint for a one-bucket window and empties for none', () => {
    expect(formatStatsWindow('week', [{ start: '2026-07-13', label: '2026-07-13' }])).toBe(
      '1 weeks · Jul 13, 2026',
    );
    expect(formatStatsWindow('day', [])).toBe('');
  });
});
