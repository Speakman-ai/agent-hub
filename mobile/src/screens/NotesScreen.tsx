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
  Modal,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import * as ImagePicker from 'expo-image-picker';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { getServerBaseUrl } from '../utils/config';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { SidebarContext } from '../context/SidebarContext';
import { listMarkdownSections, listMarkdownLineItems } from '@shared/utils/markdownSections';
import { pickTodoColumn } from '@shared/utils/pickTodoColumn';
import {
  buildAttachmentMarkdown,
  insertAtSelection,
  transformRange,
} from '@shared/utils/noteAttachments';

// Resolve a renderable URI for a markdown image src. Absolute URLs and data
// URLs pass through; server-hosted `/uploads/...` paths resolve against the
// server root so uploaded note images load on-device.
function resolveMobileMediaUrl(src: any) {
  if (!src || typeof src !== 'string') return src;
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
  if (src.startsWith('/')) return `${getServerBaseUrl()}${src}`;
  return src;
}

// Custom markdown image rule — the default renderer can't resolve relative
// `/uploads/...` srcs, so we resolve and render a network <Image>.
const markdownRules = {
  image: (node: any) => {
    const uri = resolveMobileMediaUrl(node?.attributes?.src);
    if (!uri) return null;
    return (
      <Image
        key={node.key}
        source={{ uri }}
        style={{ width: '100%', height: 220, borderRadius: 8, marginVertical: 8 }}
        resizeMode="contain"
      />
    );
  },
};
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
function cleanSnippet(snippet: any) {
  if (!snippet) return '';
  return String(snippet).replace(/<\/?(mark|b)>/gi, '');
}

export interface PendingAttach {
  range: { start: number; end: number };
  session: number;
}

/**
 * Re-anchor a pending attachment across a content edit so its insertion point
 * survives edits made while the picker/upload awaits are pending (see
 * transformRange). Pure so the mobile attach flow is unit-testable.
 */
export function nextPendingRangeOnEdit(
  pending: PendingAttach | null,
  oldText: string,
  newText: string,
): PendingAttach | null {
  if (!pending) return pending;
  return { ...pending, range: transformRange(pending.range, oldText || '', newText || '') };
}

/**
 * Decide how a completed upload applies to the current buffer. Returns null when
 * the edit session changed since the attach began (user canceled the editor or
 * switched/created a note) — the attachment is dropped rather than written into
 * the wrong buffer. Otherwise inserts the snippet at the pending (edit-tracked)
 * range, falling back to end-of-content when there is no live pending anchor.
 * Pure so the mobile attach flow is unit-testable without the native pickers.
 */
export function computeAttachInsertion(opts: {
  session: number;
  currentSession: number;
  pending: PendingAttach | null;
  baseText: string;
  snippet: string;
}): { text: string; cursor: number } | null {
  const { session, currentSession, pending, baseText, snippet } = opts;
  if (currentSession !== session) return null; // session changed → reject
  const base = baseText || '';
  const r =
    pending && pending.session === session
      ? pending.range
      : { start: base.length, end: base.length };
  const start = Math.min(r.start, base.length);
  const end = Math.min(r.end, base.length);
  return insertAtSelection(base, snippet, start, end);
}

export default function NotesScreen({ route }: any) {
  const { projects } = useApp();
  const { openSidebar } = React.useContext(SidebarContext);
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p: any) => p.id === projectId);
  const [notes, setNotes] = useState<any[]>([]);
  const [selectedNote, setSelectedNote] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [scoping, setScoping] = useState(false);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [ticketing, setTicketing] = useState(false);
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false);
  const boardColumnsRef = useRef<any>(null);
  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [attaching, setAttaching] = useState(false);
  // Caret position in the content field so an inserted image lands where the
  // user was typing. Reset whenever the edit buffer changes (edit/create/select)
  // so it never carries a stale offset from a previously edited note, and
  // defaults to end-of-content when the field was never focused.
  const contentSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Mutex guarding handleAttachImage against re-entry — `attaching` state flips
  // asynchronously and only after the picker resolves, so a ref is what actually
  // prevents two overlapping attach operations.
  const attachingRef = useRef(false);
  // Monotonic edit-session token. Bumped whenever the edit buffer's identity
  // changes (edit, create, select, save, cancel, back). An attach captures the
  // token before its awaits and discards its completion if the token moved — so
  // an upload that resolves after the user switched/closed the note never writes
  // into the wrong buffer.
  const editSessionRef = useRef(0);
  // The in-flight attachment's insertion range + the session it belongs to.
  // Transformed on every content change (transformRange) so it survives edits
  // the user makes while the picker/upload awaits are pending.
  const pendingAttachRef = useRef<PendingAttach | null>(null);
  const resetContentSelection = (content: string) => {
    const end = (content || '').length;
    contentSelectionRef.current = { start: end, end };
  };
  const bumpEditSession = () => {
    editSessionRef.current += 1;
    // A pending attachment belongs to the session that started it; once the
    // buffer identity changes its captured range is meaningless.
    pendingAttachRef.current = null;
  };
  // Content edits go through here so a pending attachment's anchor tracks them.
  const handleEditContentChange = (next: string) => {
    setEditContent((prev: any) => {
      pendingAttachRef.current = nextPendingRangeOnEdit(pendingAttachRef.current, prev || '', next);
      return next;
    });
  };
  // Debounce search (300ms) to match web behavior
  const searchTimeout = useRef<any>(null);
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
    } catch (err: any) {
      console.warn('Failed to load notes:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, debouncedSearch]);
  useEffect(() => {
    loadNotes();
  }, [loadNotes]);
  const handleSelectNote = async (note: any) => {
    bumpEditSession();
    try {
      const full = await api.getNote(projectId, note.id);
      setSelectedNote(full);
      setEditing(false);
      setCreating(false);
      boardColumnsRef.current = null;
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load note');
    }
  };
  const handleEdit = () => {
    if (!selectedNote) return;
    bumpEditSession();
    setEditTitle(selectedNote.title || '');
    setEditContent(selectedNote.content || '');
    resetContentSelection(selectedNote.content || '');
    setEditing(true);
    setCreating(false);
  };
  const handleCreate = () => {
    bumpEditSession();
    setEditTitle('');
    setEditContent('');
    resetContentSelection('');
    setCreating(true);
    setEditing(false);
    setSelectedNote(null);
  };
  const handleSave = async () => {
    if (!editTitle.trim()) {
      Alert.alert('Error', 'Title is required');
      return;
    }
    bumpEditSession();
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
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save');
    }
  };
  const handleDelete = (note: any) => {
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
          } catch (err: any) {
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
  const runProcess = async (date: any, mode: any) => {
    setProcessing(true);
    try {
      await api.processNote(projectId, date, { mode });
      Alert.alert('Processing started', 'An agent session will extract insights from this note.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to process note');
    } finally {
      setProcessing(false);
    }
  };
  // Sections available to scope (one per heading) for the selected note.
  const scopeSections = selectedNote ? listMarkdownSections(selectedNote.content || '') : [];
  const handleScope = () => {
    if (!selectedNote || scoping) return;
    // With headings, let the user pick a heading-scoped block or the whole
    // note; otherwise scope the whole note directly.
    if (scopeSections.length > 0) {
      setScopePickerOpen(true);
    } else {
      runScope(selectedNote.content, selectedNote.title);
    }
  };
  const runScope = async (content: any, title: any) => {
    if (!content || !String(content).trim()) return;
    setScopePickerOpen(false);
    setScoping(true);
    try {
      await api.scopeFromNotes(projectId, { content: String(content), title: title || undefined });
      Alert.alert(
        'Scoping session started',
        'An agent session will scope these notes into an epic, phases, and tickets.',
      );
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to start scoping session');
    } finally {
      setScoping(false);
    }
  };
  // Line items available to convert into tickets for the selected note.
  const lineItems = selectedNote ? listMarkdownLineItems(selectedNote.content || '') : [];
  const handleTicket = () => {
    if (!selectedNote || ticketing) return;
    if (lineItems.length === 0) {
      Alert.alert('No line items', 'This note has no bullet/list items to convert into tickets.');
      return;
    }
    setTicketPickerOpen(true);
  };
  const resolveTodoColumn = async () => {
    if (!boardColumnsRef.current) {
      const board = await api.getProjectBoard(projectId, { limit: 'all' });
      boardColumnsRef.current = board?.columns || [];
    }
    return pickTodoColumn(boardColumnsRef.current || []);
  };
  const createTicketFromLine = async (text: any) => {
    const t = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return;
    setTicketPickerOpen(false);
    setTicketing(true);
    try {
      const column = await resolveTodoColumn();
      if (!column) throw new Error('No board column available');
      await api.createKanbanCard(projectId, { title: t, columnId: column.id });
      Alert.alert(
        'Ticket created',
        `Added “${t.length > 60 ? t.slice(0, 60) + '…' : t}” to To Do.`,
      );
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create ticket');
    } finally {
      setTicketing(false);
    }
  };
  const handleAttachImage = async () => {
    if (attachingRef.current) return;
    attachingRef.current = true;
    // Snapshot the insertion RANGE NOW, before the permission / picker / upload
    // awaits — the content field stays editable across them, so reading the
    // selection afterwards could be stale, belong to a different note, or still
    // be the initial {0,0} of an unfocused field. Keep both endpoints so the
    // insert REPLACES a selected range like a normal paste.
    const sel = contentSelectionRef.current;
    const range =
      sel && typeof sel.start === 'number'
        ? {
            start: Math.min(sel.start, sel.end ?? sel.start),
            end: Math.max(sel.start, sel.end ?? sel.start),
          }
        : { start: (editContent || '').length, end: (editContent || '').length };
    // Bind this upload to the edit session that started it; discard on mismatch.
    const session = editSessionRef.current;
    // Register the pending anchor so content edits during the awaits transform
    // it (see handleEditContentChange) instead of leaving a stale offset.
    pendingAttachRef.current = { range, session };
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to attach an image.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
      });
      if (result.canceled || !result.assets?.length) return;
      setAttaching(true);
      const asset = result.assets[0];
      const name = asset.fileName || `image-${Date.now()}.jpg`;
      const type = asset.mimeType || 'image/jpeg';
      const res = await api.uploadFile({ uri: asset.uri, name, type, size: asset.fileSize });
      if (!res?.url) throw new Error('Upload returned no URL');
      // The picker/upload awaits may have outlived the edit session (user
      // canceled the editor or opened/created another note). Dropping here keeps
      // the image out of the wrong buffer.
      if (editSessionRef.current !== session) return;
      const snippet = buildAttachmentMarkdown({ name, url: res.url, contentType: type });
      setEditContent((prev: any) => {
        // computeAttachInsertion re-checks the session (React may batch this
        // after a transition) and inserts at the edit-tracked pending range.
        const applied = computeAttachInsertion({
          session,
          currentSession: editSessionRef.current,
          pending: pendingAttachRef.current,
          baseText: prev,
          snippet,
        });
        if (!applied) return prev;
        contentSelectionRef.current = { start: applied.cursor, end: applied.cursor };
        pendingAttachRef.current = null;
        return applied.text;
      });
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to attach image');
    } finally {
      setAttaching(false);
      attachingRef.current = false;
      // Clear any anchor left by an early return (permission denied, canceled,
      // upload error, session mismatch) so it can't leak into a later attach.
      if (pendingAttachRef.current && pendingAttachRef.current.session === session) {
        pendingAttachRef.current = null;
      }
    }
  };
  const handleCancel = () => {
    bumpEditSession();
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
            keyExtractor={(item: any) => item.id}
            renderItem={({ item }: any) => (
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
            bumpEditSession();
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
            <TouchableOpacity
              onPress={handleProcess}
              style={styles.headerAction}
              disabled={processing}
            >
              <Text style={styles.headerActionText}>{processing ? '…' : 'Process'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleScope} style={styles.headerAction} disabled={scoping}>
              <Text style={styles.headerActionText}>{scoping ? '…' : 'Scope'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleTicket}
              style={styles.headerAction}
              disabled={ticketing}
            >
              <Text style={styles.headerActionText}>{ticketing ? '…' : 'Ticket'}</Text>
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

            <View style={styles.contentLabelRow}>
              <Text style={styles.fieldLabel}>Content (Markdown)</Text>
              <TouchableOpacity
                onPress={handleAttachImage}
                disabled={attaching}
                style={styles.attachButton}
              >
                <Text style={styles.attachButtonText}>{attaching ? 'Uploading…' : '+ Image'}</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.contentInput}
              value={editContent}
              onChangeText={handleEditContentChange}
              onSelectionChange={(e: any) => {
                contentSelectionRef.current = e.nativeEvent.selection;
              }}
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
            <Text style={styles.noteMeta}>Updated {relativeTime(selectedNote?.updated_at)}</Text>
          </View>
          <View style={styles.markdownContainer}>
            <Markdown style={mdStyles as any} rules={markdownRules as any}>
              {selectedNote?.content || '*No content yet*'}
            </Markdown>
          </View>
        </ScrollView>
      )}

      <Modal
        visible={scopePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setScopePickerOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setScopePickerOpen(false)}
        >
          <View style={styles.scopeSheet}>
            <Text style={styles.scopeSheetTitle}>Scope into a planning session</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              <TouchableOpacity
                style={styles.scopeOption}
                onPress={() => runScope(selectedNote?.content, selectedNote?.title)}
              >
                <Text style={styles.scopeOptionTitle}>Whole note</Text>
                <Text style={styles.scopeOptionMeta}>Everything in “{selectedNote?.title}”</Text>
              </TouchableOpacity>
              {scopeSections.map((s: any, i: any) => (
                <TouchableOpacity
                  key={`${s.line}-${i}`}
                  style={styles.scopeOption}
                  onPress={() => runScope(s.section, s.heading)}
                >
                  <Text style={styles.scopeOptionTitle} numberOfLines={1}>
                    {'#'.repeat(s.level)} {s.heading || 'Untitled section'}
                  </Text>
                  <Text style={styles.scopeOptionMeta}>Everything under this heading</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.scopeCancel} onPress={() => setScopePickerOpen(false)}>
              <Text style={styles.scopeCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={ticketPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTicketPickerOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setTicketPickerOpen(false)}
        >
          <View style={styles.scopeSheet}>
            <Text style={styles.scopeSheetTitle}>Convert a line into a To Do ticket</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {lineItems.map((it: any, i: any) => (
                <TouchableOpacity
                  key={`${it.line}-${i}`}
                  style={styles.scopeOption}
                  onPress={() => createTicketFromLine(it.text)}
                >
                  <Text
                    style={[
                      styles.scopeOptionTitle,
                      { color: colors.emerald400, marginLeft: Math.min(it.indent, 8) * 2 },
                    ]}
                    numberOfLines={2}
                  >
                    {it.text}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.scopeCancel} onPress={() => setTicketPickerOpen(false)}>
              <Text style={styles.scopeCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
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
  contentLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  attachButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    marginBottom: 6,
  },
  attachButtonText: { fontSize: 13, color: colors.blue600, fontWeight: '600' },
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  scopeSheet: {
    backgroundColor: colors.gray900,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    borderTopWidth: 1,
    borderColor: colors.gray800,
  },
  scopeSheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 12,
  },
  scopeOption: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.gray800,
    marginBottom: 8,
  },
  scopeOptionTitle: { fontSize: 15, fontWeight: '600', color: colors.blue600 },
  scopeOptionMeta: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  scopeCancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  scopeCancelText: { fontSize: 14, fontWeight: '600', color: colors.gray400 },
});
