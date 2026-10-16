import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { describeApproval, formatApprovalExpiry } from '@shared/utils/approvals';
import { formatPolicyDomain } from '@shared/utils/desktopAppPolicy';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import { colors } from '../theme/colors';
import ApprovalActions from './ApprovalActions';

/**
 * In-app approval card above the chat composer (web `SessionApprovalBanner`
 * parity). The agent's turn is parked until each request is answered, so the
 * card stays until the server says it settled.
 */
export default function SessionApprovalCard({ sessionId }: { sessionId: string | null }) {
  const { pending, drop } = usePendingApprovals({ sessionId });
  if (!sessionId || pending.length === 0) return null;

  return (
    <View style={styles.container} testID="session-approval-card">
      {pending.map((a) => (
        <View key={a.id} style={styles.card} accessibilityRole="alert" testID="session-approval">
          <Text style={styles.heading}>
            Approval needed: <Text style={styles.what}>{describeApproval(a)}</Text>
          </Text>
          <Text style={styles.meta}>
            {a.domain ? `on ${formatPolicyDomain(a.domain)} · ` : ''}
            {formatApprovalExpiry(a.expiresAt)}
          </Text>
          {a.details ? <Text style={styles.details}>{a.details}</Text> : null}
          <ApprovalActions approval={a} onSettled={drop} testIDPrefix="session-approval" />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  card: {
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(217, 119, 6, 0.5)',
    backgroundColor: colors.amber900_40,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  heading: { color: '#FEF3C7', fontSize: 14, fontWeight: '600' },
  what: { color: '#FFFBEB', fontWeight: '400' },
  meta: { color: 'rgba(253, 230, 138, 0.8)', fontSize: 12 },
  details: { color: 'rgba(254, 243, 199, 0.85)', fontSize: 12 },
});
