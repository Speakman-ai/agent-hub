import React, { useState, useEffect } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { buildEditPrPayload } from '../utils/prReviewActions';
import PrActionSheet from './PrActionSheet';

/**
 * PrEditSheet — edit the title/description of an open native PR
 * (PATCH /api/projects/:id/pulls/:n). Prefills from the current PR;
 * `onSubmit(payload)` should throw on failure so the sheet can surface
 * the error inline and stay open.
 */
export default function PrEditSheet({ visible, pr, onClose, onSubmit }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Re-seed from the PR each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setTitle(pr?.title || '');
      setBody(pr?.body || '');
      setError(null);
      setBusy(false);
    }
  }, [visible, pr]);

  const submit = async () => {
    if (busy) return;
    const built = buildEditPrPayload({ title, body });
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
      setError(err?.message || 'Failed to save changes');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PrActionSheet
      visible={visible}
      title={`Edit PR #${pr?.number ?? ''}`}
      submitLabel="Save"
      onSubmit={submit}
      onClose={onClose}
      busy={busy}
      submitDisabled={!title.trim()}
      error={error}
    >
      <TextInput
        style={styles.titleInput}
        value={title}
        onChangeText={(t) => {
          setTitle(t);
          if (error) setError(null);
        }}
        placeholder="PR title"
        placeholderTextColor={colors.gray500}
        editable={!busy}
      />
      <TextInput
        style={styles.bodyInput}
        value={body}
        onChangeText={setBody}
        placeholder="Description (markdown)"
        placeholderTextColor={colors.gray500}
        multiline
        editable={!busy}
      />
    </PrActionSheet>
  );
}

const styles = StyleSheet.create({
  titleInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bodyInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.gray200,
    fontSize: 13,
    fontFamily: 'monospace',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 160,
    textAlignVertical: 'top',
  },
});
