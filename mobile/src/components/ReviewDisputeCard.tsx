import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  formatReviewDisputeLocation,
  type ExtractedReviewDisputeBlock,
} from '@shared/utils/extractReviewDisputeBlocks';
import { colors } from '../theme/colors';

/** Mobile twin of the web `ReviewDisputeCard`: one row per disputed finding. */
export default function ReviewDisputeCard({ block }: { block: ExtractedReviewDisputeBlock }) {
  const { disputes, raw, partial } = block;
  const count = disputes.length;
  const title = partial
    ? 'Disputing review findings…'
    : count > 0
      ? `Disputed ${count} review finding${count === 1 ? '' : 's'}`
      : 'Review dispute';
  return (
    <View style={styles.card} testID="review-dispute-card">
      <Text style={styles.title}>{title}</Text>
      {count > 0 ? (
        disputes.map((d, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.location} selectable>
              {formatReviewDisputeLocation(d)}
            </Text>
            <Text style={styles.reason} selectable>
              {d.reason}
            </Text>
          </View>
        ))
      ) : !partial && raw ? (
        <Text style={styles.raw} selectable>
          {raw}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    backgroundColor: 'rgba(245, 158, 11, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: { color: colors.amber400, fontWeight: '600', fontSize: 13 },
  row: { marginTop: 8 },
  location: { color: colors.amber400, fontFamily: 'Courier', fontSize: 11 },
  reason: { color: colors.gray300, fontSize: 13, marginTop: 2 },
  raw: { color: colors.gray400, fontFamily: 'Courier', fontSize: 11, marginTop: 8 },
});
