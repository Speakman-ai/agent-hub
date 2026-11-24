import React, { useRef, useState, type ReactNode } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Check, Folder, FolderPlus } from 'lucide-react-native';
import type { SessionFolderWire } from '@shared/utils/sessionFolders';
import { colors } from '../theme/colors';

const NAME_MAX = 80;

/** Inline name field; submits on return or blur, ignores empty and unchanged names. */
export function FolderNameField({
  initial = '',
  onCommit,
  onCancel,
  testID,
}: {
  initial?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  testID?: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <TextInput
      style={styles.input}
      value={value}
      autoFocus
      maxLength={NAME_MAX}
      placeholder="Folder name"
      placeholderTextColor={colors.gray600}
      onChangeText={setValue}
      onSubmitEditing={finish}
      onBlur={finish}
      testID={testID}
    />
  );
}

/**
 * Collapsible folder group. Long-press offers rename and delete; deleting keeps
 * the sessions, which move back to the unfiled list.
 */
export function SessionFolderGroup({
  folder,
  count,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  folder: SessionFolderWire;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const showActions = () =>
    Alert.alert(folder.name, 'Sessions in a deleted folder move back to the list.', [
      { text: 'Rename', onPress: () => setEditing(true) },
      { text: 'Delete folder', style: 'destructive', onPress: onDelete },
      { text: 'Cancel', style: 'cancel' },
    ]);
  return (
    <View testID={`session-folder-${folder.id}`}>
      {editing ? (
        <View style={styles.header}>
          <Folder size={12} color={colors.gray500} />
          <FolderNameField
            initial={folder.name}
            testID={`session-folder-rename-input-${folder.id}`}
            onCommit={(name) => {
              setEditing(false);
              onRename(name);
            }}
            onCancel={() => setEditing(false)}
          />
        </View>
      ) : (
        <TouchableOpacity
          style={styles.header}
          onPress={onToggle}
          onLongPress={showActions}
          delayLongPress={400}
          accessibilityLabel={`${collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
          testID={`session-folder-toggle-${folder.id}`}
        >
          <Text style={styles.chevron}>{collapsed ? '▸' : '▾'}</Text>
          <Folder size={12} color={colors.gray500} />
          <Text style={styles.name} numberOfLines={1}>
            {folder.name}
          </Text>
          <Text style={styles.count}>{count}</Text>
        </TouchableOpacity>
      )}
      {!collapsed && <View style={styles.children}>{children}</View>}
    </View>
  );
}

/** Inline picker shown under a session row: pick a folder, unfile, or create one. */
export function MoveToFolderPicker({
  sessionId,
  folders,
  currentFolderId,
  onMove,
  onCreateAndMove,
  onClose,
}: {
  sessionId: string;
  folders: SessionFolderWire[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
  onCreateAndMove: (name: string) => void;
  onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <View style={styles.picker} testID={`session-folder-menu-${sessionId}`}>
      {folders.map((f) => (
        <TouchableOpacity
          key={f.id}
          style={styles.option}
          disabled={f.id === currentFolderId}
          onPress={() => onMove(f.id)}
        >
          {f.id === currentFolderId ? (
            <Check size={12} color={colors.gray400} />
          ) : (
            <Folder size={12} color={colors.gray500} />
          )}
          <Text style={styles.optionText} numberOfLines={1}>
            {f.name}
          </Text>
        </TouchableOpacity>
      ))}
      {currentFolderId ? (
        <TouchableOpacity style={styles.option} onPress={() => onMove(null)}>
          <Text style={styles.optionText}>Remove from folder</Text>
        </TouchableOpacity>
      ) : null}
      {creating ? (
        <View style={styles.option}>
          <FolderNameField
            testID={`session-folder-menu-new-input-${sessionId}`}
            onCommit={onCreateAndMove}
            onCancel={() => setCreating(false)}
          />
        </View>
      ) : (
        <TouchableOpacity style={styles.option} onPress={() => setCreating(true)}>
          <FolderPlus size={12} color={colors.gray500} />
          <Text style={styles.optionText}>New folder…</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.option} onPress={onClose}>
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 6,
    marginBottom: 2,
  },
  chevron: { fontSize: 11, color: colors.gray500 },
  name: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '600', color: colors.gray400 },
  count: { fontSize: 10, color: colors.gray600 },
  children: { marginLeft: 12, borderLeftWidth: 1, borderLeftColor: colors.gray800, paddingLeft: 4 },
  picker: {
    marginLeft: 8,
    marginBottom: 6,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  optionText: { flex: 1, minWidth: 0, fontSize: 12, color: colors.gray300 },
  cancelText: { fontSize: 12, color: colors.gray500 },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.gray200,
    fontSize: 12,
    backgroundColor: colors.gray700,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
