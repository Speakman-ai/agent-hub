import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';

/** Operator control to ship via POST /sessions/:id/ship (system callout, no slash in chat). */
export default function ChangesReadyBox({
  sessionId,
  changes,
  onTrigger,
  onDismiss,
  isSessionProcessing = false,
  shipFailureAt = null,
}) {
  const [requestPending, setRequestPending] = useState(false);
  const [awaitingAgentTurn, setAwaitingAgentTurn] = useState(false);
  const sawProcessingRef = useRef(false);

  const isCreating = requestPending || awaitingAgentTurn;

  useEffect(() => {
    if (!awaitingAgentTurn) {
      sawProcessingRef.current = false;
      return;
    }
    if (isSessionProcessing) {
      sawProcessingRef.current = true;
      return;
    }
    if (sawProcessingRef.current) {
      setAwaitingAgentTurn(false);
      sawProcessingRef.current = false;
    }
  }, [awaitingAgentTurn, isSessionProcessing]);

  useEffect(() => {
    if (!awaitingAgentTurn) return undefined;
    const timer = setTimeout(() => setAwaitingAgentTurn(false), 120_000);
    return () => clearTimeout(timer);
  }, [awaitingAgentTurn]);

  useEffect(() => {
    if (shipFailureAt) setAwaitingAgentTurn(false);
  }, [shipFailureAt]);

  const handlePress = async () => {
    if (isCreating) return;
    setRequestPending(true);
    try {
      await onTrigger?.(sessionId);
      setAwaitingAgentTurn(true);
    } catch {
      setAwaitingAgentTurn(false);
    } finally {
      setRequestPending(false);
    }
  };

  const label = isCreating ? 'Creating ticket & PR…' : 'Create ticket & PR';

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.icon}>🔀</Text>
          <Text style={styles.title}>Changes ready</Text>
          {!!changes?.branch && (
            <Text style={styles.branch} numberOfLines={1}>
              ({changes.branch})
            </Text>
          )}
        </View>
        {onDismiss && !isCreating ? (
          <TouchableOpacity
            onPress={() => onDismiss(sessionId)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.dismiss}>✕</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={handlePress}
        disabled={isCreating}
        style={[styles.button, isCreating && styles.buttonDisabled]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: isCreating, busy: isCreating }}
      >
        {isCreating ? (
          <View style={styles.creatingRow}>
            <ActivityIndicator color={colors.white} size="small" />
            <Text style={styles.buttonText}>{label}</Text>
          </View>
        ) : (
          <Text style={styles.buttonText}>{label}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const PURPLE = '#7C3AED';

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 12,
    backgroundColor: 'rgba(31, 41, 55, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(55, 65, 81, 0.6)',
    borderRadius: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: 6,
  },
  icon: { fontSize: 14, color: colors.purple400 },
  title: { color: colors.gray300, fontWeight: '600', fontSize: 14 },
  branch: {
    color: colors.gray500,
    fontSize: 11,
    marginLeft: 2,
    flexShrink: 1,
  },
  dismiss: { color: colors.gray500, fontSize: 14, paddingHorizontal: 4 },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: PURPLE,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.85,
  },
  creatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
});
