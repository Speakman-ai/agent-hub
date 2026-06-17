import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { SidebarContext } from '../context/SidebarContext';

const mdStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    borderRadius: 3,
    fontSize: 13,
  },
  fence: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  code_block: { color: colors.gray200, fontSize: 13 },
  link: { color: colors.blue600, textDecorationLine: 'none' },
  heading1: { color: colors.white, fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  heading2: { color: colors.white, fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  heading3: { color: colors.white, fontSize: 16, fontWeight: '600', marginBottom: 4 },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { marginBottom: 2 },
  blockquote: {
    backgroundColor: colors.gray800,
    borderLeftColor: colors.gray600,
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginVertical: 8,
  },
  strong: { color: colors.white, fontWeight: 'bold' },
  em: { color: colors.gray300, fontStyle: 'italic' },
  hr: { backgroundColor: colors.gray700, height: 1, marginVertical: 16 },
};

/** Strip FTS highlight tags (<mark>, <b>) so snippets render cleanly inline. */
function cleanSnippet(snippet) {
  if (!snippet) return '';
  return String(snippet).replace(/<\/?(mark|b)>/gi, '');
}

export default function NotesScreen({ route }) {
  const { projects } = useApp();
  const { openSidebar } = React.useContext(SidebarContext);

  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p) => p.id === projectId);

  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  // Debounce search (300ms) to match web behavior
  const searchTimeout = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [searchQuery]);

  const loadNotes = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await api.getNotes(projectId, debouncedSearch);
      setNotes(data || []);
    } catch (err) {
      console.warn('Failed to load notes:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, debouncedSearch]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleSelectNote = async (note) => {
    try {
      const full = await api.getNote(projectId, note.id);
      setSelectedNote(full);
      setEditing(false);
      setCreating(false);
    } catch (err) {
      Alert.alert('Error', 'Failed to load note');
    }
  };

  const handleEdit = () => {
    if (!selectedNote) return;
    setEditTitle(selectedNote.title || '');
    setEditContent(selectedNote.content || '');
    setEditing(true);
    setCreating(false);
  };

  const handleCreate = () => {
    setEditTitle('');
    setEditContent('');
    setCreating(true);
    setEditing(false);
    setSelectedNote(null);
  };

  const handleSave = async () => {
    if (!editTitle.trim()) {
      Alert.alert('Error', 'Title is required');
      return;
    }
    try {
      if (creating) {
        const note = await api.createNote(projectId, {
          title: editTitle.trim(),
          content: editContent,
        });
        setSelectedNote(note);
        setCreating(false);
      } else if (editing && selectedNote) {
        const note = await api.updateNote(projectId, selectedNote.id, {
          title: editTitle.trim(),
          content: editContent,
        });
        setSelectedNote(note);
        setEditing(false);
      }
      loadNotes();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save');
    }
  };

  const handleDelete = (note) => {
    Alert.alert('Delete Note', `Delete "${note.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteNote(projectId, note.id);
            if (selectedNote?.id === note.id) {
              setSelectedNote(null);
              setEditing(false);
            }
            loadNotes();
          } catch (err) {
            Alert.alert('Error', 'Failed to delete');
          }
        },
      },
    ]);
  };

  const handleProcess = () => {
    if (!selectedNote || processing) return;
    const noteDate = selectedNote.date || selectedNote.id;
    Alert.alert('Process note', 'Extract insights into wiki, memory, or kanban?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Wiki',
        onPress: () => runProcess(noteDate, 'wiki'),
      },
      {
        text: 'Memory',
        onPress: () => runProcess(noteDate, 'memory'),
      },
      {
        text: 'Both',
        onPress: () => runProcess(noteDate, 'both'),
      },
    ]);
  };

  const runProcess = async (date, mode) => {
    setProcessing(true);
    try {
      await api.processNote(projectId, date, { mode });
      Alert.alert('Processing started', 'An agent session will extract insights from this note.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to process note');
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setCreating(false);
    if (!selectedNote) setCreating(false);
  };

  // List view (no note selected, not creating)
  if (!selectedNote && !creating) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
            <Text style={styles.menuIcon}>{'\u2630'}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Notes</Text>
          {project && (
            <Text style={styles.projectLabel} numberOfLines={1}>
              {project.name}
            </Text>
          )}
          <TouchableOpacity onPress={handleCreate} style={styles.addButton}>
            <Text style={styles.addButtonText}>+</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search notes..."
            placeholderTextColor={colors.gray600}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        {notes.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {loading ? 'Loading…' : debouncedSearch ? 'No matches' : 'No notes yet'}
            </Text>
            {!debouncedSearch && !loading && (
              <>
                <Text style={styles.emptyDesc}>
                  Quick-capture thoughts, snippets, and ideas. Notes are project-scoped and
                  searchable across the web and mobile clients.
                </Text>
                <TouchableOpacity style={styles.emptyButton} onPress={handleCreate}>
                  <Text style={styles.emptyButtonText}>Create First Note</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : (
          <FlatList
            data={notes}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.noteItem}
                onPress={() => handleSelectNote(item)}
                onLongPress={() => handleDelete(item)}
              >
                <Text style={styles.noteTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {item.snippet ? (
                  <Text style={styles.noteSnippet} numberOfLines={2}>
                    {cleanSnippet(item.snippet)}
                  </Text>
                ) : null}
                <View style={styles.noteItemFooter}>
                  <Text style={styles.noteMeta}>{relativeTime(item.updated_at)}</Text>
                </View>
              </TouchableOpacity>
            )}
            contentContainerStyle={{ padding: 12 }}
          />
        )}
      </SafeAreaView>
    );
  }

  // Detail / edit / create view
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => {
            setSelectedNote(null);
            setEditing(false);
            setCreating(false);
          }}
          style={styles.menuButton}
        >
          <Text style={styles.backIcon}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {creating ? 'New Note' : selectedNote?.title || 'Note'}
        </Text>
        <View style={{ flex: 1 }} />
        {!editing && !creating && selectedNote && (
          <>
            <TouchableOpacity onPress={handleProcess} style={styles.headerAction} disabled={processing}>
              <Text style={styles.headerActionText}>{processing ? '…' : 'Process'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleEdit} style={styles.headerAction}>
              <Text style={styles.headerActionText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleDelete(selectedNote)}
              style={styles.headerAction}
            >
              <Text style={[styles.headerActionText, { color: '#ef4444' }]}>Delete</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {editing || creating ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView style={styles.editContainer} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.fieldInput}
              value={editTitle}
              onChangeText={setEditTitle}
              placeholder="Note title"
              placeholderTextColor={colors.gray600}
            />

            <Text style={styles.fieldLabel}>Content (Markdown)</Text>
            <TextInput
              style={styles.contentInput}
              value={editContent}
              onChangeText={setEditContent}
              placeholder="Write your note in markdown..."
              placeholderTextColor={colors.gray600}
              multiline
              textAlignVertical="top"
            />

            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                <Text style={styles.saveButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <ScrollView style={styles.viewContainer}>
          <View style={styles.noteHeader}>
            <Text style={styles.noteViewTitle}>{selectedNote?.title}</Text>
            <Text style={styles.noteMeta}>
              Updated {relativeTime(selectedNote?.updated_at)}
            </Text>
          </View>
          <View style={styles.markdownContainer}>
            <Markdown style={mdStyles}>{selectedNote?.content || '*No content yet*'}</Markdown>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: { padding: 4 },
  menuIcon: { fontSize: 22, color: colors.gray400 },
  backIcon: { fontSize: 22, color: colors.gray400 },
  title: { fontSize: 17, fontWeight: '600', color: colors.white },
  projectLabel: { fontSize: 12, color: colors.gray500, maxWidth: 100 },
  addButton: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.gray800,
    borderRadius: 6,
  },
  addButtonText: { fontSize: 18, color: colors.gray300, fontWeight: '600' },
  headerAction: { paddingHorizontal: 8, paddingVertical: 4 },
  headerActionText: { fontSize: 14, color: colors.blue600, fontWeight: '500' },
  searchContainer: { paddingHorizontal: 12, paddingVertical: 8 },
  searchInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.white,
  },
  noteItem: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  noteTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 4,
  },
  noteSnippet: {
    fontSize: 12,
    color: colors.gray500,
    marginBottom: 6,
  },
  noteItemFooter: { flexDirection: 'row', justifyContent: 'space-between' },
  noteMeta: { fontSize: 11, color: colors.gray600 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.gray400, marginBottom: 8 },
  emptyDesc: {
    fontSize: 14,
    color: colors.gray600,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  emptyButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyButtonText: { color: colors.white, fontSize: 14, fontWeight: '600' },
  viewContainer: { flex: 1, padding: 16 },
  noteHeader: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  noteViewTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    marginBottom: 8,
  },
  markdownContainer: { paddingBottom: 40 },
  editContainer: { flex: 1, padding: 16 },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray500,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.white,
    marginBottom: 16,
  },
  contentInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.white,
    minHeight: 240,
    marginBottom: 16,
  },
  editActions: { flexDirection: 'row', gap: 12, marginBottom: 40 },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.gray800,
    alignItems: 'center',
  },
  cancelButtonText: { fontSize: 14, fontWeight: '600', color: colors.gray400 },
  saveButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.blue600,
    alignItems: 'center',
  },
  saveButtonText: { fontSize: 14, fontWeight: '600', color: colors.white },
});
