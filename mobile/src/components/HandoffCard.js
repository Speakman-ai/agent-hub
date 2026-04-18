import React, { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors } from '../theme/colors';

/**
 * HandoffCard (mobile)
 * --------------------
 * Compact visual treatment for `<handoff>` blocks in chat. Mirrors the web
 * client's `HandoffCard.jsx` so the agent-coordination story looks the same
 * across platforms. Without this the raw `<handoff>{...}</handoff>` JSON
 * shows up in the assistant bubble as a wall of text — the bug this card
 * fixes.
 *
 * Props:
 *   note            — the handoff note, rendered as markdown.
 *   toAgentId       — required; raw target agent id from the parsed block.
 *   fromAgent       — { name, color } describing the source agent. Optional.
 *   agents          — full agents list used to resolve `toAgentId` →
 *                     display name + color. Optional; falls back to the raw
 *                     id when the agent isn't found.
 *   handoff         — optional DB row from GET /api/sessions/:id/handoffs.
 *                     When present we use its `to_agent_id` +
 *                     `to_session_id` + `status` to render a tappable
 *                     "Open session" button plus pending / failed pills.
 *   onOpenSession   — optional callback `(agentId, sessionId) => void`
 *                     invoked when the user taps "Open session".
 */
function HandoffCard({ note, toAgentId, fromAgent, agents, handoff, onOpenSession }) {
  // Prefer the resolved agent id stored on the DB row — the server's fuzzy
  // resolver may have rewritten things like "agent-hub-backend" → the real
  // id. Fall back to the raw block id so legacy / pre-delivery renders
  // still work.
  const resolvedToAgentId = handoff?.to_agent_id || toAgentId;
  const toAgent = resolveAgent(resolvedToAgentId, agents);
  const fromName = fromAgent?.name ?? null;
  const fromColor = fromAgent?.color ?? colors.gray500;
  const toName = toAgent?.name ?? resolvedToAgentId;
  const toColor = toAgent?.color ?? colors.gray500;
  const toSessionId = handoff?.to_session_id ?? null;
  const status = handoff?.status ?? null;
  const errorText = handoff?.error ?? null;
  const canOpen = !!(toSessionId && resolvedToAgentId && typeof onOpenSession === 'function');

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>HANDOFF</Text>
        {fromName && (
          <>
            <Chip name={fromName} color={fromColor} />
            <Text style={styles.arrow}>→</Text>
          </>
        )}
        <Chip name={toName} color={toColor} highlight />
      </View>
      <View style={styles.body}>
        <Text style={styles.noteLabel}>NOTE</Text>
        <Markdown style={markdownStyles}>{note}</Markdown>
      </View>
      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          Ownership transferred — the new session continues with the transcript above as context.
        </Text>
        {canOpen && (
          <TouchableOpacity
            style={styles.openBtn}
            onPress={() => onOpenSession(resolvedToAgentId, toSessionId)}
            accessibilityRole="button"
            accessibilityLabel={`Open the ${toName} session started by this handoff`}
          >
            <Text style={styles.openBtnText}>↗ Open session</Text>
          </TouchableOpacity>
        )}
        {!canOpen && status === 'pending' && (
          <View style={styles.pendingPill}>
            <View style={styles.pendingDot} />
            <Text style={styles.pendingText}>Delivering…</Text>
          </View>
        )}
        {status === 'failed' && (
          <View style={styles.failedPill}>
            <Text style={styles.failedText} numberOfLines={2}>
              ⚠ Failed{errorText ? ` — ${errorText}` : ''}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function Chip({ name, color, highlight }) {
  return (
    <View style={[styles.chip, highlight && styles.chipHighlight]}>
      <View style={[styles.chipDot, { backgroundColor: color }]} />
      <Text
        style={[styles.chipText, highlight && styles.chipTextHighlight]}
        numberOfLines={1}
      >
        {name}
      </Text>
    </View>
  );
}

function resolveAgent(agentId, agents) {
  if (!agentId || !Array.isArray(agents)) return null;
  return agents.find((a) => a?.id === agentId) ?? null;
}

const AMBER_BG = 'rgba(120, 53, 15, 0.25)'; // amber-950/25
const AMBER_BORDER = 'rgba(180, 83, 9, 0.4)'; // amber-700/40
const AMBER_TEXT = '#fcd34d'; // amber-300
const AMBER_TEXT_SOFT = 'rgba(252, 211, 77, 0.7)'; // amber-300/70

const styles = StyleSheet.create({
  card: {
    marginVertical: 8,
    borderWidth: 1,
    borderColor: AMBER_BORDER,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: AMBER_BG,
    borderBottomWidth: 1,
    borderBottomColor: AMBER_BORDER,
    flexWrap: 'wrap',
  },
  headerLabel: {
    color: AMBER_TEXT,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  arrow: { color: AMBER_TEXT, fontSize: 14, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(31, 41, 55, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  chipHighlight: { backgroundColor: 'rgba(120, 53, 15, 0.35)' },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: colors.gray300, fontSize: 12, fontWeight: '500', maxWidth: 140 },
  chipTextHighlight: { color: '#fde68a' /* amber-200 */ },
  body: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  noteLabel: {
    color: 'rgba(254, 240, 138, 0.5)' /* amber-200/50 */,
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: 4,
  },
  footer: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  footerNote: {
    flex: 1,
    minWidth: 140,
    color: colors.gray500,
    fontSize: 11,
    fontStyle: 'italic',
  },
  openBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(120, 53, 15, 0.45)',
    borderWidth: 1,
    borderColor: 'rgba(180, 83, 9, 0.6)',
  },
  openBtnText: {
    color: '#fde68a' /* amber-200 */,
    fontSize: 11,
    fontWeight: '600',
  },
  pendingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pendingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: AMBER_TEXT,
  },
  pendingText: {
    color: AMBER_TEXT_SOFT,
    fontSize: 11,
    fontWeight: '600',
  },
  failedPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(127, 29, 29, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(185, 28, 28, 0.5)',
    maxWidth: '100%',
  },
  failedText: {
    color: colors.red400,
    fontSize: 11,
    fontWeight: '600',
  },
});

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 13, lineHeight: 19 },
  paragraph: { marginTop: 2, marginBottom: 4 },
  bullet_list: { marginTop: 2, marginBottom: 4 },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    fontSize: 12,
  },
};

export default memo(HandoffCard);
