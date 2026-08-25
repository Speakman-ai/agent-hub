import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Linking,
  Alert,
} from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import {
  normalizeSessionSummary,
  formatInjectedBytes,
  splitSessionRoster,
} from '../utils/sessionExtras';
import { modelDisplay } from '../utils/engineOptions';
const BADGE_TONES: Record<string, any> = {
  purple: { color: colors.purple400, bg: colors.purple900_40 },
  red: { color: colors.red400, bg: colors.red900_50 },
  emerald: { color: colors.emerald400, bg: colors.emerald900_40 },
  yellow: { color: colors.yellow400, bg: colors.yellow900_50 },
  blue: { color: colors.blue400, bg: colors.blue900_40 },
};
/**
 * Session summary sheet — mobile counterpart of the web
 * SessionSummarySidebar. Fetches GET /api/sessions/:id/summary when opened
 * and renders the linked PR (status badge + tappable URL), the skills the
 * session has loaded, and the session's agent roster (executor + advisors,
 * passed in from context since the summary endpoint doesn't include them).
 */
export default function SessionSummarySheet({
  visible,
  onClose,
  sessionId,
  sessionAgents = [],
}: any) {
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  useEffect(() => {
    if (!visible || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getSessionSummary(sessionId)
      .then((data: any) => {
        if (cancelled || sessionIdRef.current !== sessionId) return;
        setSummary(normalizeSessionSummary(data));
        setLoading(false);
      })
      .catch((err: any) => {
        if (cancelled || sessionIdRef.current !== sessionId) return;
        setSummary(null);
        setError(err?.message || 'Failed to load summary');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, sessionId]);
  const openPr = async (url: any) => {
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch (err: any) {
      Alert.alert('Could not open PR', err?.message || url);
    }
  };
  const { executor, advisors } = splitSessionRoster(sessionAgents);
  const tone = summary?.prBadge ? BADGE_TONES[summary.prBadge.tone] || BADGE_TONES.blue : null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <AppIcon name="information-circle-outline" size={16} color={colors.gray400} />
              <Text style={styles.headerTitle}>Session summary</Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close session summary"
            >
              <AppIcon name="close" size={20} color={colors.gray400} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {loading && (
              <View style={styles.center}>
                <ActivityIndicator size="small" color={colors.gray400} />
                <Text style={styles.dimText}>Loading…</Text>
              </View>
            )}

            {!loading && error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {!loading && !error && summary && (
              <>
                {/* Session name + engine/model */}
                {summary.sessionName ? (
                  <Text style={styles.sessionName} numberOfLines={2}>
                    {summary.sessionName}
                  </Text>
                ) : null}
                {(summary.engine || summary.model) && (
                  <Text style={styles.dimText}>
                    {[summary.engine, summary.model ? modelDisplay(summary.model).label : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                )}

                {/* Linked ticket */}
                {summary.linkedCardTitle ? (
                  <>
                    <Text style={styles.sectionLabel}>TICKET</Text>
                    <View style={styles.prCard}>
                      <View style={styles.prTitleRow}>
                        <AppIcon name="pricetag-outline" size={14} color={colors.gray400} />
                        <Text style={styles.prTitle} numberOfLines={2}>
                          {summary.linkedCardTitle}
                        </Text>
                        {summary.linkedCardColumn ? (
                          <View style={[styles.badge, { backgroundColor: colors.gray800 }]}>
                            <Text style={[styles.badgeText, { color: colors.gray200 }]}>
                              {summary.linkedCardColumn}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </>
                ) : null}

                {/* Linked PR */}
                <Text style={styles.sectionLabel}>LINKED PR</Text>
                {summary.linkedPrUrl ? (
                  <TouchableOpacity
                    style={styles.prCard}
                    onPress={() => openPr(summary.linkedPrUrl)}
                    accessibilityRole="link"
                    accessibilityLabel={`Open pull request ${summary.prNumber ? `#${summary.prNumber}` : ''}`}
                  >
                    <View style={styles.prTitleRow}>
                      <AppIcon name="git-pull-request-outline" size={14} color={colors.gray400} />
                      <Text style={styles.prTitle} numberOfLines={2}>
                        {summary.prNumber ? `PR #${summary.prNumber}` : 'Pull request'}
                        {summary.linkedCardTitle ? ` — ${summary.linkedCardTitle}` : ''}
                      </Text>
                      {summary.prBadge && tone && (
                        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
                          <Text style={[styles.badgeText, { color: tone.color }]}>
                            {summary.prBadge.label}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.prUrl} numberOfLines={1}>
                      {summary.linkedPrUrl}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.emptyText}>No PR linked to this session.</Text>
                )}

                {/* Skills */}
                <Text style={styles.sectionLabel}>SKILLS USED</Text>
                {summary.skills.length === 0 ? (
                  <Text style={styles.emptyText}>No skills loaded yet.</Text>
                ) : (
                  <View style={styles.chipWrap}>
                    {summary.skills.map((s: any) => (
                      <View key={s.id} style={styles.chip}>
                        <Text style={styles.chipText}>{s.skillId}</Text>
                        {formatInjectedBytes(s.injectedBytes) ? (
                          <Text style={styles.chipMeta}>
                            {formatInjectedBytes(s.injectedBytes)}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}

                {/* Agent roster */}
                <Text style={styles.sectionLabel}>AGENTS</Text>
                {!executor && advisors.length === 0 ? (
                  <Text style={styles.emptyText}>No agents on this session.</Text>
                ) : (
                  <View style={styles.agentList}>
                    {executor && (
                      <View style={styles.agentRow}>
                        <View
                          style={[
                            styles.agentDot,
                            { backgroundColor: executor.color || colors.gray500 },
                          ]}
                        />
                        <Text style={styles.agentName} numberOfLines={1}>
                          {executor.name || executor.id}
                        </Text>
                        <Text style={styles.agentRole}>executor</Text>
                      </View>
                    )}
                    {advisors.map((a: any) => (
                      <View key={a.id} style={styles.agentRow}>
                        <View
                          style={[styles.agentDot, { backgroundColor: a.color || colors.gray500 }]}
                        />
                        <Text style={styles.agentName} numberOfLines={1}>
                          {a.name || a.id}
                        </Text>
                        <Text style={styles.agentRole}>advisor</Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.black50,
    justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  body: {
    maxHeight: 480,
  },
  bodyContent: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  center: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
  },
  dimText: {
    color: colors.gray500,
    fontSize: 12,
  },
  errorBox: {
    borderWidth: 1,
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
    borderRadius: 8,
    padding: 10,
  },
  errorText: {
    color: colors.amber400,
    fontSize: 12,
  },
  sessionName: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 6,
  },
  prCard: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  prTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  prTitle: {
    color: colors.gray200,
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  prUrl: {
    color: colors.blue400,
    fontSize: 11,
  },
  emptyText: {
    color: colors.gray500,
    fontSize: 12,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    color: colors.gray200,
    fontSize: 11,
  },
  chipMeta: {
    color: colors.gray500,
    fontSize: 10,
  },
  agentList: {
    gap: 6,
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  agentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  agentName: {
    color: colors.gray200,
    fontSize: 13,
    flexShrink: 1,
  },
  agentRole: {
    color: colors.gray500,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
