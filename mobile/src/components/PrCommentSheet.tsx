import React, { useState, useEffect } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { buildGeneralCommentPayload } from '../utils/prReviewActions';
import PrActionSheet from './PrActionSheet';
/**
 * PrCommentSheet — post a general comment on a native PR. Under the hood
 * this is a review with state 'commented' (the native PR surface has no
 * standalone issue-comment endpoint), matching the web review composer.
 * `onSubmit(payload)` should throw on failure.
 */
export default function PrCommentSheet({ visible, prNumber, onClose, onSubmit }: any) {
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<any>(null);
    useEffect(() => {
        if (visible) {
            setBody('');
            setError(null);
            setBusy(false);
        }
    }, [visible]);
    const submit = async () => {
        if (busy)
            return;
        const built = buildGeneralCommentPayload(body);
        if (!built.ok) {
            setError(built.error);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSubmit(built.payload);
            onClose();
        }
        catch (err: any) {
            setError(err?.message || 'Failed to post comment');
        }
        finally {
            setBusy(false);
        }
    };
    return (<PrActionSheet visible={visible} title={`Comment on PR #${prNumber}`} submitLabel="Post comment" onSubmit={submit} onClose={onClose} busy={busy} submitDisabled={!body.trim()} error={error}>
      <TextInput style={styles.bodyInput} value={body} onChangeText={(t: any) => {
            setBody(t);
            if (error)
                setError(null);
        }} placeholder="Leave a comment…" placeholderTextColor={colors.gray500} multiline autoFocus editable={!busy}/>
    </PrActionSheet>);
}
const styles = StyleSheet.create({
    bodyInput: {
        backgroundColor: colors.gray950,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        color: colors.gray200,
        fontSize: 14,
        paddingHorizontal: 10,
        paddingVertical: 8,
        minHeight: 110,
        textAlignVertical: 'top',
    },
});
