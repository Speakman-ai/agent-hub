import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../theme/colors';
import {
  defaultScheduleDate,
  deviceTimeZone,
  isFutureLocalDateTime,
  toLocalDateTimeValue,
} from '@shared/utils/autoMergeSchedule';

interface Props {
  visible: boolean;
  /** Stored UTC ISO time from the PR summary, or null. */
  scheduledAt: string | null | undefined;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  /** Local wall-clock `YYYY-MM-DDTHH:mm`, or null to clear. */
  onSubmit: (localDateTime: string | null) => void;
}

const DAYS_AHEAD = 14;
const MINUTE_STEP = 5;

/** Day chips + hour/minute steppers in device-local time (no native picker dependency). */
export default function ScheduleAutoMergeSheet({
  visible,
  scheduledAt,
  busy,
  error,
  onCancel,
  onSubmit,
}: Props) {
  const [picked, setPicked] = useState<Date>(() => defaultScheduleDate());
  const [localError, setLocalError] = useState<string | null>(null);
  const zone = deviceTimeZone();

  useEffect(() => {
    if (!visible) return;
    const current = scheduledAt ? new Date(scheduledAt) : null;
    setPicked(current && current.getTime() > Date.now() ? current : defaultScheduleDate());
    setLocalError(null);
  }, [visible, scheduledAt]);

  const days = (() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS_AHEAD }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  })();

  const setDay = (day: Date) => {
    const next = new Date(day);
    next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    setPicked(next);
  };
  const shift = (minutes: number) => {
    setPicked(new Date(picked.getTime() + minutes * 60_000));
  };

  const submit = () => {
    const value = toLocalDateTimeValue(picked);
    if (!isFutureLocalDateTime(value)) {
      setLocalError('Pick a time in the future.');
      return;
    }
    onSubmit(value);
  };

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Schedule auto-merge</Text>
          <Text style={styles.subtle}>Times are in {zone}</Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.days}>
            {days.map((d) => {
              const active = sameDay(d, picked);
              return (
                <TouchableOpacity
                  key={d.toISOString()}
                  onPress={() => setDay(d)}
                  style={[styles.dayChip, active && styles.dayChipActive]}
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                    {d.toLocaleDateString(undefined, { weekday: 'short' })}
                  </Text>
                  <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                    {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.timeRow}>
            <Stepper label="Hour" onMinus={() => shift(-60)} onPlus={() => shift(60)} />
            <Text style={styles.timeText}>
              {picked.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </Text>
            <Stepper
              label="Min"
              onMinus={() => shift(-MINUTE_STEP)}
              onPlus={() => shift(MINUTE_STEP)}
            />
          </View>

          <Text style={styles.subtle}>
            At this time Agent Hub arms auto-merge. If checks or reviews are still pending, it
            merges as soon as they pass.
          </Text>
          {localError || error ? <Text style={styles.error}>{localError || error}</Text> : null}

          <View style={styles.actions}>
            {scheduledAt ? (
              <TouchableOpacity onPress={() => onSubmit(null)} disabled={busy}>
                <Text style={[styles.actionText, { color: colors.red400 }]}>Clear</Text>
              </TouchableOpacity>
            ) : (
              <View />
            )}
            <View style={styles.actionsRight}>
              <TouchableOpacity onPress={onCancel} disabled={busy}>
                <Text style={styles.actionText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={busy}
                style={styles.primary}
                accessibilityLabel="Save auto-merge schedule"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Text style={styles.primaryText}>{scheduledAt ? 'Update' : 'Schedule'}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Stepper({
  label,
  onMinus,
  onPlus,
}: {
  label: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <View style={styles.stepper}>
      <TouchableOpacity
        onPress={onMinus}
        style={styles.stepBtn}
        accessibilityLabel={`${label} down`}
      >
        <Text style={styles.stepBtnText}>−</Text>
      </TouchableOpacity>
      <Text style={styles.stepLabel}>{label}</Text>
      <TouchableOpacity onPress={onPlus} style={styles.stepBtn} accessibilityLabel={`${label} up`}>
        <Text style={styles.stepBtnText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.black60 },
  sheet: {
    backgroundColor: colors.gray900,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 12,
  },
  title: { color: colors.gray100, fontSize: 16, fontWeight: '600' },
  subtle: { color: colors.gray400, fontSize: 12 },
  error: { color: colors.red400, fontSize: 12 },
  days: { flexGrow: 0 },
  dayChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginRight: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    alignItems: 'center',
  },
  dayChipActive: { borderColor: colors.sky400, backgroundColor: colors.gray800 },
  dayChipText: { color: colors.gray300, fontSize: 12 },
  dayChipTextActive: { color: colors.sky300 },
  timeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timeText: { color: colors.gray100, fontSize: 22, fontWeight: '600' },
  stepper: { alignItems: 'center', gap: 4 },
  stepBtn: {
    width: 36,
    height: 32,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { color: colors.gray100, fontSize: 18 },
  stepLabel: { color: colors.gray500, fontSize: 11 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actionsRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  actionText: { color: colors.gray300, fontSize: 14 },
  primary: {
    backgroundColor: colors.blue600,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    minWidth: 84,
    alignItems: 'center',
  },
  primaryText: { color: colors.white, fontSize: 14, fontWeight: '600' },
});
