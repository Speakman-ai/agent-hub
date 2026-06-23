import React from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, } from 'react-native';
import { colors } from '../theme/colors';
/**
 * PrActionSheet — shared bottom-sheet scaffold for the PR detail actions
 * (review / comment / edit). Renders a dark card with a title, arbitrary
 * children (form fields), an inline error line, and Cancel / submit
 * buttons with busy + disabled handling.
 */
export default function PrActionSheet({ visible, title, submitLabel, onSubmit, onClose, busy = false, submitDisabled = false, error = null, children, }: any) {
    return (<Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={busy ? null : onClose}/>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.bodyScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.submitButton, (busy || submitDisabled) && styles.submitDisabled]} onPress={onSubmit} disabled={busy || submitDisabled} accessibilityState={{ disabled: busy || submitDisabled, busy }}>
              {busy ? (<ActivityIndicator size="small" color={colors.white}/>) : (<Text style={styles.submitText}>{submitLabel}</Text>)}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>);
}
const styles = StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: colors.black60,
    },
    sheet: {
        backgroundColor: colors.gray900,
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        borderWidth: 1,
        borderColor: colors.gray800,
        padding: 16,
        paddingBottom: 28,
        maxHeight: '85%',
    },
    title: { color: colors.white, fontSize: 16, fontWeight: '600', marginBottom: 12 },
    bodyScroll: { flexGrow: 0 },
    bodyContent: { gap: 10 },
    errorText: { color: colors.red400, fontSize: 12, marginTop: 8 },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 16,
        marginTop: 14,
    },
    cancelButton: { paddingVertical: 8, paddingHorizontal: 8 },
    cancelText: { color: colors.gray400, fontSize: 14 },
    submitButton: {
        backgroundColor: colors.emerald500,
        borderRadius: 8,
        paddingHorizontal: 18,
        paddingVertical: 10,
        minWidth: 130,
        alignItems: 'center',
    },
    submitDisabled: { opacity: 0.5 },
    submitText: { color: colors.white, fontSize: 14, fontWeight: '600' },
});
