import React, { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { silenceWarningMessage } from '@shared/utils/audioLevel';
import { colors } from '../theme/colors';
import type { VoiceLevelStore } from '../utils/voiceLevel';

const BARS = 5;

/** Live view of what the recorder hears, with a warning on a silent take. */
export default function VoiceLevelMeter({ store }: { store: VoiceLevelStore }) {
  const { level, warning } = useSyncExternalStore(store.subscribe, store.get, store.get);
  const lit = Math.round(level * BARS);
  return (
    <View style={styles.row}>
      <View
        style={styles.bars}
        accessibilityRole="progressbar"
        accessibilityLabel="Microphone level"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
        testID="voice-level-meter"
      >
        {Array.from({ length: BARS }, (_, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { height: 5 + i * 2 },
              {
                backgroundColor:
                  i < lit ? (warning ? colors.amber400 : colors.emerald400) : colors.gray600,
              },
            ]}
          />
        ))}
      </View>
      {warning ? (
        <Text
          style={styles.warning}
          accessibilityLiveRegion="polite"
          testID="voice-silence-warning"
        >
          {silenceWarningMessage(warning)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 13 },
  bar: { width: 3, borderRadius: 1 },
  warning: { flex: 1, fontSize: 12, color: colors.amber400 },
});
