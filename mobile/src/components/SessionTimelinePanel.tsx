/**
 * SessionTimelinePanel — mobile parity for the web SessionTimelineSidebar.
 *
 * Web shows a toggleable left rail; mobile has no side pane, so this is an
 * inline collapsible list above the chat (same chrome as the terminal toggle).
 */
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import {
  deriveSessionTimelineMarkers,
  type SessionTimelineKind,
  type SessionTimelineMarker,
} from '@shared/utils/sessionTimeline';

const KIND_ICON: Record<SessionTimelineKind, string> = {
  change_summary: 'git-compare-outline',
  test_run: 'flask-outline',
  review_comment: 'chatbubble-outline',
};

const KIND_LABEL: Record<SessionTimelineKind, string> = {
  change_summary: 'Change summary',
  test_run: 'Checks',
  review_comment: 'Review comment',
};

function statusColor(marker: SessionTimelineMarker): string {
  if (marker.status === 'fail') return colors.red400;
  if (marker.status === 'ok' && marker.kind === 'test_run') return colors.emerald400;
  if (marker.status === 'pending') return colors.yellow400;
  if (marker.kind === 'change_summary') return colors.blue400;
  if (marker.kind === 'review_comment') return colors.yellow400;
  return colors.emerald400;
}

function kindLabel(kind: SessionTimelineKind): string {
  switch (kind) {
    case 'change_summary':
      return KIND_LABEL.change_summary;
    case 'test_run':
      return KIND_LABEL.test_run;
    case 'review_comment':
      return KIND_LABEL.review_comment;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function SessionTimelinePanelContent({
  markers = [],
  selectedAnchorId = null,
  onSelect,
}: {
  markers?: SessionTimelineMarker[];
  selectedAnchorId?: string | null;
  onSelect?: (marker: SessionTimelineMarker) => void;
}) {
  return (
    <View style={styles.panel} testID="session-timeline-panel">
      <View style={styles.header}>
        <AppIcon name="time-outline" size={14} color={colors.gray400} />
        <Text style={styles.headerTitle}>Timeline</Text>
        {markers.length > 0 ? <Text style={styles.headerBadge}>{markers.length}</Text> : null}
      </View>
      {markers.length === 0 ? (
        <Text style={styles.empty}>
          Markers appear here for each turn's change summary, finalize checks, and review comment.
        </Text>
      ) : (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {markers.map((marker) => {
            const selected = selectedAnchorId === marker.anchorId;
            return (
              <TouchableOpacity
                key={marker.id}
                testID="session-timeline-marker"
                accessibilityRole="button"
                onPress={() => onSelect?.(marker)}
                style={[styles.row, selected && styles.rowSelected]}
              >
                <View style={[styles.dot, { backgroundColor: statusColor(marker) }]} />
                <View style={styles.rowBody}>
                  <View style={styles.kindRow}>
                    <AppIcon name={KIND_ICON[marker.kind]} size={11} color={colors.gray500} />
                    <Text style={styles.kindLabel}>{kindLabel(marker.kind)}</Text>
                    {marker.createdAt ? (
                      <Text style={styles.when}>{relativeTime(marker.createdAt)}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.title} numberOfLines={2}>
                    {marker.title}
                  </Text>
                  {marker.subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {marker.subtitle}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

export default function SessionTimelinePanel({
  messages,
  selectedAnchorId = null,
  onSelect,
}: {
  messages?: any[] | null;
  selectedAnchorId?: string | null;
  onSelect?: (marker: SessionTimelineMarker) => void;
}) {
  const markers = useMemo(() => deriveSessionTimelineMarkers({ messages }), [messages]);
  return (
    <SessionTimelinePanelContent
      markers={markers}
      selectedAnchorId={selectedAnchorId}
      onSelect={onSelect}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    maxHeight: 220,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray950,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  headerTitle: {
    color: colors.gray300,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  headerBadge: {
    color: colors.gray500,
    fontSize: 11,
  },
  empty: {
    color: colors.gray500,
    fontSize: 12,
    paddingBottom: 8,
    lineHeight: 18,
  },
  list: {
    maxHeight: 170,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  rowSelected: {
    backgroundColor: colors.gray800,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  kindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  kindLabel: {
    color: colors.gray500,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    flex: 1,
  },
  when: {
    color: colors.gray500,
    fontSize: 10,
  },
  title: {
    color: colors.gray200,
    fontSize: 13,
    marginTop: 2,
  },
  subtitle: {
    color: colors.gray500,
    fontSize: 11,
    marginTop: 2,
  },
});
