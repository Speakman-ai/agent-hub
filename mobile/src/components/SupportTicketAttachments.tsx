import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  Linking,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { resolveUploadUrl } from '../utils/supportTickets';
import {
  formatAttachmentSize,
  uploadSupportTicketAttachments,
} from '../utils/supportTicketAttachments';

// Files attached to a support ticket: tap to open, long-press to remove, and
// "Add files" picks several documents at once (web parity).
export default function SupportTicketAttachments({ projectId, ticket, onUpdated }: any) {
  const attachments: any[] = Array.isArray(ticket?.attachments) ? ticket.attachments : [];
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const pick = async () => {
    // Loaded on demand so screens embedding this list don't pull the native
    // module in at import time.
    const DocumentPicker = await import('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const files = result.assets.map((a: any) => ({ uri: a.uri, name: a.name }));
    setProgress({ done: 0, total: files.length });
    const { failures } = await uploadSupportTicketAttachments(projectId, ticket.id, files, {
      onTicket: onUpdated,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setProgress(null);
    if (failures.length) Alert.alert('Some files were not attached', failures.join('\n'));
  };

  const confirmRemove = (a: any) => {
    Alert.alert('Remove file?', a.filename, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            const res = await api.deleteSupportTicketAttachment(projectId, ticket.id, a.id);
            if (res?.ticket) onUpdated?.(res.ticket);
          } catch (err: any) {
            Alert.alert('Remove failed', err?.message || 'Failed to remove file');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.section} testID="detail-attachments">
      <Text style={styles.title}>
        Attachments{attachments.length ? ` (${attachments.length})` : ''}
      </Text>
      {attachments.map((a: any) => {
        const url = resolveUploadUrl(a.ref);
        const isImage = typeof a.mime === 'string' && a.mime.startsWith('image/');
        return (
          <TouchableOpacity
            key={a.id}
            testID="ticket-attachment"
            style={styles.row}
            onPress={() => (url ? Linking.openURL(url).catch(() => {}) : undefined)}
            onLongPress={() => confirmRemove(a)}
            accessibilityHint="Long-press to remove"
          >
            {isImage && url ? (
              <Image source={{ uri: url }} style={styles.thumb} resizeMode="cover" />
            ) : (
              <View style={[styles.thumb, styles.fileIcon]}>
                <Text style={styles.fileIconText}>FILE</Text>
              </View>
            )}
            <Text style={styles.name} numberOfLines={1}>
              {a.filename}
            </Text>
            <Text style={styles.size}>{formatAttachmentSize(a.size_bytes)}</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        testID="add-attachments-button"
        style={styles.addButton}
        onPress={pick}
        disabled={!!progress}
      >
        {progress ? <ActivityIndicator size="small" color={colors.gray300} /> : null}
        <Text style={styles.addText}>
          {progress
            ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : 'Add files'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12, gap: 6 },
  title: { fontSize: 11, fontWeight: '700', color: colors.gray500, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  thumb: { width: 48, height: 36, borderRadius: 4, backgroundColor: colors.gray900 },
  fileIcon: { alignItems: 'center', justifyContent: 'center' },
  fileIconText: { color: colors.gray500, fontSize: 9, fontWeight: '700' },
  name: { flex: 1, color: colors.blue400, fontSize: 13 },
  size: { color: colors.gray600, fontSize: 11 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  addText: { color: colors.gray300, fontSize: 12 },
});
