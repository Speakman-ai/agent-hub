import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import SessionSummarySheet from './SessionSummarySheet';

/**
 * Slim action strip under the chat header for the active session's extras:
 *  - "Summary" — opens SessionSummarySheet (linked PR, skills, agent roster)
 *  - "View changes" — navigates to the SessionChanges screen (worktree diff);
 *    only rendered when `showViewChanges` (sessions default to worktrees, so
 *    callers default this to true).
 */
export default function SessionExtrasBar({
  sessionId,
  sessionAgents = [],
  showViewChanges = true,
  onViewChanges,
}) {
  const [showSummary, setShowSummary] = useState(false);

  if (!sessionId) return null;

  return (
    <View style={styles.bar}>
      <TouchableOpacity
        style={styles.button}
        onPress={() => setShowSummary(true)}
        accessibilityRole="button"
        accessibilityLabel="Open session summary"
      >
        <Ionicons name="information-circle-outline" size={14} color={colors.gray400} />
        <Text style={styles.buttonText}>Summary</Text>
      </TouchableOpacity>

      {showViewChanges && (
        <TouchableOpacity
          style={styles.button}
          onPress={onViewChanges}
          accessibilityRole="button"
          accessibilityLabel="View code changes for this session"
        >
          <Ionicons name="git-compare-outline" size={14} color={colors.gray400} />
          <Text style={styles.buttonText}>View changes</Text>
        </TouchableOpacity>
      )}

      <SessionSummarySheet
        visible={showSummary}
        onClose={() => setShowSummary(false)}
        sessionId={sessionId}
        sessionAgents={sessionAgents}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900 + '40',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  buttonText: {
    fontSize: 11,
    color: colors.gray300,
  },
});
