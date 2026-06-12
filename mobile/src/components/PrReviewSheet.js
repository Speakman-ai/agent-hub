import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { REVIEW_EVENTS, buildReviewPayload } from '../utils/prReviewActions';
import PrActionSheet from './PrActionSheet';

const EVENT_ACCENTS = {
  APPROVE: colors.emerald400,
  REQUEST_CHANGES: colors.red400,
  COMMENT: colors.blue400,
};

/**
 * PrReviewSheet — submit an Approve / Request changes / Comment review on
 * a native (Agent Hub-hosted) PR. `onSubmit(payload)` receives the
 * server-ready `{ state, body }` body and should throw on failure; the
 * sheet shows the error inline and stays open.
 */
export default function PrReviewSheet({ visible, prNumber, onClose, onSubmit }) {
  const [event, setEvent] = useState('APPROVE');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Reset per open so a previous run's draft doesn't bleed through.
  useEffect(() => {
    if (visible) {
      setEvent('APPROVE');
      setBody('');
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const submit = async () => {
    if (busy) return;
    const built = buildReviewPayload(event, body);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(built.payload);
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to submit review');
    } finally {
      setBusy(false);
    }
  };

  const needsBody = event === 'COMMENT' && !body.trim();

  return (
    <PrActionSheet
      visible={visible}
      title={`Review PR #${prNumber}`}
      submitLabel="Submit review"
      onSubmit={submit}
      onClose={onClose}
      busy={busy}
      submitDisabled={needsBody}
      error={error}
    >
      <View style={styles.verdictRow}>
        {REVIEW_EVENTS.map((opt) => {
          const active = event === opt.event;
          const accent = EVENT_ACCENTS[opt.event] || colors.gray400;
          return (
            <TouchableOpacity
              key={opt.event}
              style={[styles.verdictButton, active && { borderColor: accent }]}
              onPress={() => {
                setEvent(opt.event);
                setError(null);
              }}
              disabled={busy}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.verdictText, active && { color: accent }]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <TextInput
        style={styles.bodyInput}
        value={body}
        onChangeText={(t) => {
          setBody(t);
          if (error) setError(null);
        }}
        placeholder="Review notes (required for comments, optional otherwise)…"
        placeholderTextColor={colors.gray500}
        multiline
        editable={!busy}
      />
    </PrActionSheet>
  );
}

const styles = StyleSheet.create({
  verdictRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  verdictButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  verdictText: { color: colors.gray400, fontSize: 13, fontWeight: '600' },
  bodyInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.gray200,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 90,
    textAlignVertical: 'top',
  },
});
