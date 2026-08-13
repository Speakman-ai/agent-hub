import React, { useState, useEffect } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { buildDismissReviewPayload } from '../utils/prReviewActions';
import PrActionSheet from './PrActionSheet';
/**
 * PrDismissSheet — dismiss a submitted verdict review on a native PR
 * (GitHub "Dismiss review"). A reason is required. `onSubmit(payload)`
 * should throw on failure so the sheet can render the error inline.
 */
export default function PrDismissSheet({ visible, prNumber, reviewer, onClose, onSubmit }: any) {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<any>(null);
    useEffect(() => {
        if (visible) {
            setReason('');
            setError(null);
            setBusy(false);
        }
    }, [visible]);
    const submit = async () => {
        if (busy)
            return;
        const built = buildDismissReviewPayload(reason);
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
            setError(err?.message || 'Failed to dismiss review');
        }
        finally {
            setBusy(false);
        }
    };
    return (<PrActionSheet visible={visible} title={`Dismiss ${reviewer ? `@${reviewer}'s` : ''} review on PR #${prNumber}`} submitLabel="Dismiss review" onSubmit={submit} onClose={onClose} busy={busy} submitDisabled={!reason.trim()} error={error}>
      <TextInput style={styles.bodyInput} value={reason} onChangeText={(t: any) => {
            setReason(t);
            if (error)
                setError(null);
        }} placeholder="Why are you dismissing this review?" placeholderTextColor={colors.gray500} multiline autoFocus editable={!busy}/>
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
        minHeight: 90,
        textAlignVertical: 'top',
    },
});
