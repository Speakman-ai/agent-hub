import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import { buildKanbanColumnEditPayload } from '../utils/kanbanColumnEdit';
import { isSystemLockedColumnName } from '../utils/kanbanColumns';

const COLUMN_COLOR_PRESETS = ['#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#6B7280'];

type ColumnRow = {
  id: string;
  name: string;
  position: number;
  color?: string | null;
};

type KanbanColumnsModalProps = {
  visible: boolean;
  projectId: string;
  columns: ColumnRow[];
  columnCounts?: Record<string, number>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
};

export default function KanbanColumnsModal({
  visible,
  projectId,
  columns,
  columnCounts = {},
  onClose,
  onChanged,
}: KanbanColumnsModalProps) {
  const [editing, setEditing] = useState<ColumnRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLUMN_COLOR_PRESETS[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setEditing(null);
      setCreating(false);
      setName('');
      setColor(COLUMN_COLOR_PRESETS[0]);
      return;
    }
    if (creating) {
      setName('');
      setColor(COLUMN_COLOR_PRESETS[columns.length % COLUMN_COLOR_PRESETS.length]);
    } else if (editing) {
      setName(editing.name);
      setColor(editing.color || COLUMN_COLOR_PRESETS[0]);
    }
  }, [visible, creating, editing, columns.length]);

  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const cardCount = editing ? columnCounts[editing.id] ?? 0 : 0;
  const locked = editing ? isSystemLockedColumnName(editing.name) : false;
  const deleteBlocked = locked || cardCount > 0 || sorted.length <= 1;

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    setName('');
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || !projectId) return;
    setBusy(true);
    try {
      if (creating) {
        await api.createKanbanColumn(projectId, { name: trimmed, color });
      } else if (editing) {
        await api.updateKanbanColumn(
          projectId,
          editing.id,
          buildKanbanColumnEditPayload({
            currentName: editing.name,
            nextName: trimmed,
            color,
            locked,
          }),
        );
      }
      closeEditor();
      await onChanged();
    } catch (err: any) {
      Alert.alert('Column error', err?.message || 'Failed to save column');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = () => {
    if (!editing || deleteBlocked) return;
    Alert.alert('Delete column', `Delete "${editing.name}" permanently?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.deleteKanbanColumn(projectId, editing.id);
            closeEditor();
            await onChanged();
          } catch (err: any) {
            Alert.alert('Column error', err?.message || 'Failed to delete column');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const showEditor = creating || editing != null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <Text style={styles.title}>Board columns</Text>

          {showEditor ? (
            <ScrollView>
              <Text style={styles.label}>{creating ? 'New column' : 'Edit column'}</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Column name"
                placeholderTextColor={colors.gray600}
                autoFocus
                editable={!locked}
              />
              {locked ? (
                <Text style={styles.hint}>
                  To Do, In Progress, and Done are required by board automation. You can change
                  color only.
                </Text>
              ) : null}
              <Text style={styles.label}>Color</Text>
              <View style={styles.colorRow}>
                {COLUMN_COLOR_PRESETS.map((preset) => (
                  <TouchableOpacity
                    key={preset}
                    onPress={() => setColor(preset)}
                    style={[
                      styles.swatch,
                      { backgroundColor: preset },
                      color === preset && styles.swatchActive,
                    ]}
                  />
                ))}
              </View>
              {editing && deleteBlocked ? (
                <Text style={styles.hint}>
                  {locked
                    ? 'System columns cannot be deleted.'
                    : cardCount > 0
                    ? `Move or delete ${cardCount} card${cardCount === 1 ? '' : 's'} before deleting this column.`
                    : 'A board must have at least one column.'}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <TouchableOpacity style={styles.secondaryBtn} onPress={closeEditor} disabled={busy}>
                  <Text style={styles.secondaryText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, (!name.trim() || busy) && styles.primaryBtnDisabled]}
                  onPress={handleSave}
                  disabled={!name.trim() || busy}
                >
                  <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
              {editing ? (
                <TouchableOpacity
                  style={[styles.deleteBtn, deleteBlocked && styles.deleteBtnDisabled]}
                  onPress={handleDelete}
                  disabled={deleteBlocked || busy}
                >
                  <Text style={styles.deleteText}>Delete column</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          ) : (
            <>
              <ScrollView style={styles.list}>
                {sorted.map((col) => (
                  <TouchableOpacity
                    key={col.id}
                    style={styles.row}
                    onPress={() => {
                      setCreating(false);
                      setEditing(col);
                    }}
                  >
                    <View style={[styles.dot, { backgroundColor: col.color || colors.gray500 }]} />
                    <Text style={styles.rowText}>{col.name}</Text>
                    <Text style={styles.rowMeta}>{columnCounts[col.id] ?? 0}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.addBtn}
                onPress={() => {
                  setEditing(null);
                  setCreating(true);
                }}
              >
                <Text style={styles.addBtnText}>+ Add column</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={onClose}>
                <Text style={styles.secondaryText}>Close</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '85%',
    backgroundColor: colors.gray900,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: colors.gray800,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.white,
    fontSize: 14,
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  swatchActive: {
    borderWidth: 2,
    borderColor: colors.white,
  },
  list: {
    maxHeight: 320,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  rowText: {
    flex: 1,
    color: colors.gray100,
    fontSize: 14,
  },
  rowMeta: {
    color: colors.gray500,
    fontSize: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  addBtn: {
    marginBottom: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  addBtnText: {
    color: colors.gray200,
    fontSize: 14,
    fontWeight: '500',
  },
  primaryBtn: {
    backgroundColor: '#4F46E5',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryBtnDisabled: {
    opacity: 0.5,
  },
  primaryText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryBtn: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryText: {
    color: colors.gray400,
    fontSize: 14,
  },
  deleteBtn: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 10,
  },
  deleteBtnDisabled: {
    opacity: 0.4,
  },
  deleteText: {
    color: '#F87171',
    fontSize: 14,
  },
  hint: {
    color: colors.gray500,
    fontSize: 12,
    marginTop: 8,
  },
});
