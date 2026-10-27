import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import {
  buildMonthGrid,
  monthLabel,
  WEEKDAY_LABELS,
  type CalendarEventLike,
} from '@shared/utils/calendarEvents';

// Phone cells are narrow; two chips plus an overflow count keeps rows even.
const MAX_CHIPS = 2;

export default function CalendarMonthView({
  month,
  events,
  loading,
  error,
  onRetry,
  onPrev,
  onNext,
  onToday,
  onSelectEvent,
  eventColor,
}: {
  month: Date;
  events: CalendarEventLike[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelectEvent: (event: CalendarEventLike) => void;
  /** Per-event accent (e.g. the owning Google account's color). */
  eventColor?: (event: CalendarEventLike) => string | undefined;
}) {
  const days = useMemo(() => buildMonthGrid(month, events), [month, events]);
  const weeks = useMemo(() => {
    const rows: (typeof days)[] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [days]);

  return (
    <View style={styles.section} accessibilityLabel="Month view">
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{monthLabel(month)}</Text>
          {loading ? <ActivityIndicator size="small" color={colors.gray500} /> : null}
        </View>
        <View style={styles.nav}>
          <TouchableOpacity
            onPress={onPrev}
            style={styles.navButton}
            accessibilityLabel="Previous month"
          >
            <Text style={styles.navText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onToday} style={styles.navButton}>
            <Text style={styles.navText}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onNext}
            style={styles.navButton}
            accessibilityLabel="Next month"
          >
            <Text style={styles.navText}>›</Text>
          </TouchableOpacity>
        </View>
      </View>
      {error ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>
            Couldn&apos;t load events for {monthLabel(month)}: {error}
          </Text>
          {onRetry ? (
            <TouchableOpacity onPress={onRetry} disabled={loading} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <View style={styles.grid}>
        <View style={styles.row}>
          {WEEKDAY_LABELS.map((label) => (
            <Text key={label} style={styles.weekday}>
              {label.slice(0, 1)}
            </Text>
          ))}
        </View>
        {weeks.map((week) => (
          <View key={week[0].key} style={styles.row}>
            {week.map((day) => {
              const hidden = day.events.length - MAX_CHIPS;
              return (
                <View
                  key={day.key}
                  testID={`calendar-day-${day.key}`}
                  style={[styles.cell, !day.inMonth && styles.cellOutside]}
                >
                  <View style={[styles.dayBadge, day.isToday && styles.dayBadgeToday]}>
                    <Text
                      style={[
                        styles.dayText,
                        !day.inMonth && styles.dayTextOutside,
                        day.isToday && styles.dayTextToday,
                      ]}
                    >
                      {day.dayOfMonth}
                    </Text>
                  </View>
                  {day.events.slice(0, MAX_CHIPS).map((event, i) => (
                    <TouchableOpacity
                      key={`${event.id || event.summary || 'event'}-${i}`}
                      onPress={() => onSelectEvent(event)}
                      style={[
                        styles.chip,
                        event.start?.date ? styles.chipAllDay : null,
                        eventColor?.(event)
                          ? { borderLeftWidth: 2, borderLeftColor: eventColor(event) }
                          : null,
                      ]}
                      accessibilityLabel={event.summary || '(no title)'}
                    >
                      <Text numberOfLines={1} style={styles.chipText}>
                        {event.summary || '(no title)'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  {hidden > 0 ? <Text style={styles.more}>+{hidden}</Text> : null}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.white, fontSize: 18, fontWeight: '700' },
  nav: { flexDirection: 'row', gap: 6 },
  navButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  navText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.red400,
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
  },
  errorText: { flex: 1, color: colors.red400, fontSize: 12 },
  retryButton: {
    borderWidth: 1,
    borderColor: colors.red400,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  retryText: { color: colors.red400, fontSize: 12, fontWeight: '600' },
  grid: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '600',
    paddingVertical: 6,
  },
  cell: {
    flex: 1,
    minHeight: 64,
    padding: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gray800,
  },
  cellOutside: { backgroundColor: colors.gray950 },
  dayBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  dayBadgeToday: { backgroundColor: colors.blue600 },
  dayText: { color: colors.gray300, fontSize: 11 },
  dayTextOutside: { color: colors.gray600 },
  dayTextToday: { color: colors.white, fontWeight: '700' },
  chip: { borderRadius: 3, paddingHorizontal: 2, paddingVertical: 1, marginBottom: 1 },
  chipAllDay: { backgroundColor: colors.blue900_40 },
  chipText: { color: colors.gray300, fontSize: 9 },
  more: { color: colors.gray500, fontSize: 9, paddingHorizontal: 2 },
});
