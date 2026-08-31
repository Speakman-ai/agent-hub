import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeNotesMarkdown } from '../utils/notesMarkdown';
import { resolveServerMediaUrl } from '../utils/resolveServerMediaUrl';
import { sliceSectionAtLine } from '@shared/utils/markdownSections';
import { pickTodoColumn } from '@shared/utils/pickTodoColumn';
import {
  buildAttachmentMarkdown,
  insertAtSelection,
  transformRange,
} from '@shared/utils/noteAttachments';
import {
  StickyNote,
  Search,
  Plus,
  Trash2,
  Pencil,
  Save,
  X,
  Eye,
  SplitSquareHorizontal,
  Zap,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Telescope,
  TicketPlus,
  ImagePlus,
} from 'lucide-react';
import { api } from '../utils/api';

// Render markdown links/images so server-hosted `/uploads/...` assets resolve
// against the same origin as the UI (remote mode / Vite dev proxy). Module-scope
// constant so its identity is stable — passing it to react-markdown never forces
// a preview remount. Merged into the scope/ticket component map for view mode.
const mediaMarkdownComponents = {
  img: ({ node: _node, src, alt, ...props }: any) => (
    <img
      src={src ? resolveServerMediaUrl(src) : src}
      alt={alt}
      {...props}
      className="max-w-full h-auto rounded-lg border border-gray-800 my-2"
    />
  ),
  a: ({ node: _node, href, children, ...props }: any) => (
    <a href={href ? resolveServerMediaUrl(href) : href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
};

/**
 * Parse an FTS snippet string into an array of { text, bold } segments.
 * Strips all HTML except <b>...</b> highlight markers.
 */
function parseSnippet(html: any) {
  if (!html) return [];
  // Split on <b>...</b> pairs, capturing the bold content
  const parts = html.split(/(<b>.*?<\/b>)/gi);
  return parts
    .map((part: any) => {
      const boldMatch = part.match(/^<b>(.*?)<\/b>$/i);
      if (boldMatch) {
        return { text: stripTags(boldMatch[1]), bold: true };
      }
      return { text: stripTags(part), bold: false };
    })
    .filter((seg: any) => seg.text);
}

/**
 * Extract the text of a rendered list item, EXCLUDING any nested `<ul>`/`<ol>`
 * sub-lists — so "convert this line" uses the bullet's own text as the ticket
 * title, not the concatenation of its children.
 */
function extractLineItemText(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractLineItemText).join('');
  const type = node?.type;
  if (type === 'ul' || type === 'ol') return ''; // skip nested lists
  const children = node?.props?.children;
  return children != null ? extractLineItemText(children) : '';
}

interface ScopeComponentOpts {
  onScope: (content: string, title: string) => void;
  onTicket: (title: string) => void;
  scopingRef: { current: boolean };
  ticketingRef: { current: boolean };
  noteTitle?: string;
}

/**
 * Build the react-markdown `components` map that renders a hover "Scope" button
 * next to each heading and a hover "Ticket" button on each list item.
 *
 * IMPORTANT: this is defined at module scope (not inside render) and is meant to
 * be memoized by the caller on `normalized` + stable handler identities. If the
 * returned component functions were recreated on every render, react-markdown
 * would treat them as new element *types* and remount the entire preview subtree
 * on each keystroke / state toggle. The volatile `scoping`/`ticketing` flags are
 * read through refs so they don't force new component identities on click.
 */
function makeScopeComponents(normalized: string, opts: ScopeComponentOpts) {
  const { onScope, onTicket, scopingRef, ticketingRef, noteTitle } = opts;

  const makeHeading =
    (Tag: any) =>
    ({ node, children, ...props }: any) => {
      const line = node?.position?.start?.line;
      return (
        <Tag {...props} className="group/heading flex items-center gap-2">
          <span>{children}</span>
          {line != null && (
            <button
              type="button"
              onClick={() => {
                const sec = sliceSectionAtLine(normalized, line);
                if (sec) onScope(sec.section, sec.heading || noteTitle || '');
              }}
              disabled={scopingRef.current}
              title="Scope everything under this heading into a planning session"
              className="opacity-0 group-hover/heading:opacity-100 focus:opacity-100 flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-600/10 rounded transition-all disabled:opacity-50 no-underline"
            >
              <Telescope size={11} />
              Scope
            </button>
          )}
        </Tag>
      );
    };

  // Each list item gets a hover "Ticket" button that converts JUST that line
  // into a kanban card in the To Do column (nested sub-bullets excluded).
  const li = ({ node: _node, children, ...props }: any) => {
    const title = extractLineItemText(children).replace(/\s+/g, ' ').trim();
    return (
      <li {...props} className="group/li">
        {children}
        {title && (
          <button
            type="button"
            onClick={() => onTicket(title)}
            disabled={ticketingRef.current}
            title="Convert this line into a To Do ticket"
            aria-label={`Convert "${title}" into a To Do ticket`}
            className="ml-2 opacity-0 group-hover/li:opacity-100 focus:opacity-100 inline-flex items-center gap-1 px-1.5 py-0.5 align-middle text-[11px] font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-600/10 rounded transition-all disabled:opacity-50 no-underline"
          >
            <TicketPlus size={11} />
            Ticket
          </button>
        )}
      </li>
    );
  };

  return {
    ...mediaMarkdownComponents,
    h1: makeHeading('h1'),
    h2: makeHeading('h2'),
    h3: makeHeading('h3'),
    h4: makeHeading('h4'),
    h5: makeHeading('h5'),
    h6: makeHeading('h6'),
    li,
  };
}

/** Strip all HTML tags and decode common entities */
function stripTags(str: any) {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Render sanitized snippet with bold highlights */
function SnippetText({ snippet }: any) {
  if (!snippet) return null;
  const segments = parseSnippet(snippet);
  if (segments.length === 0) return null;
  return (
    <span className="text-xs text-gray-600 truncate">
      {segments.map((seg: any, i: any) =>
        seg.bold ? (
          <span key={i} className="text-gray-400 font-medium">
            {seg.text}
          </span>
        ) : (
          seg.text
        ),
      )}
    </span>
  );
}

function relativeTime(dateStr: any) {
  if (!dateStr) return '';
  const date = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const PROCESS_TARGETS = [
  { value: 'auto', label: 'Auto-detect', desc: 'Let the agent decide wiki, memory, or both' },
  { value: 'wiki', label: 'Wiki', desc: 'Create or update wiki pages' },
  { value: 'memory', label: 'Memory', desc: 'Update MEMORY.md with key facts' },
  { value: 'plan', label: 'Kanban', desc: 'Create kanban cards from action items' },
];

// A new note needs a non-empty title for the server to accept the create.
// Prefer what the user typed; otherwise derive from the first non-blank line
// of the content, falling back to 'Untitled'.
export function deriveNoteTitle(title: string, content: string): string {
  const t = (title || '').trim();
  if (t) return t;
  const firstLine = (content || '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  if (firstLine) return firstLine.slice(0, 100);
  return 'Untitled';
}

export default function NotesEditor({ projectId }: any) {
  const [notes, setNotes] = useState<any[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<any>(null);
  const [selectedNote, setSelectedNote] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [previewMode, setPreviewMode] = useState('edit'); // 'edit' | 'preview' | 'split'
  const [hoveredNoteId, setHoveredNoteId] = useState<any>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  // Processing state
  const [processing, setProcessing] = useState(false);
  const [processTarget, setProcessTarget] = useState('auto');
  const [processResult, setProcessResult] = useState<any>(null); // { status, message }
  const [showTargetDropdown, setShowTargetDropdown] = useState(false);
  // Scoping state — turn a note (or a heading-scoped block) into a scoping session
  const [scoping, setScoping] = useState(false);
  const [scopeResult, setScopeResult] = useState<any>(null); // { status, message }
  // Convert-line-item-to-ticket state
  const [ticketing, setTicketing] = useState(false);
  const [ticketResult, setTicketResult] = useState<any>(null); // { status, message }
  // Attachment upload state (paste / drop / toolbar button → markdown embed)
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<any>(null);
  const searchTimerRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  // Live mirrors of the edit buffers + mode so the debounced auto-save reads
  // the latest values instead of a stale closure captured at keystroke time.
  const editTitleRef = useRef('');
  const editContentRef = useRef('');
  const creatingRef = useRef(false);
  const selectedNoteIdRef = useRef<any>(null);
  // Bumped whenever the active draft/selection changes (new, cancel, edit,
  // select). An async save captures the generation before its await and only
  // applies selection/UI state if it is still current, so a create that
  // resolves after the user navigated away persists without hijacking nav.
  const draftGenRef = useRef(0);
  // Serialized write queue. Each entry is a SELF-CONTAINED snapshot of a write
  // (its own target + buffer + generation), captured at enqueue time, so a
  // queued save is never re-derived from the live refs after the user has
  // navigated away. Writes drain FIFO through a single loop; a create records
  // its new id under createdIdByGen so a later same-draft write targets it.
  // This is what guarantees no edit is lost when navigation happens while a
  // save is already in flight.
  const writeQueueRef = useRef<any[]>([]);
  const drainingRef = useRef(false);
  const createdIdByGenRef = useRef<Map<number, string>>(new Map());
  // Generations whose create has already been dispatched (in flight or done).
  // Once a gen is here its note exists (or soon will), so an empty trailing
  // buffer must be preserved as a clear — not swallowed by the empty-create
  // guard — and later converted to an update on the created id.
  const createDispatchedGensRef = useRef<Set<number>>(new Set());
  // True when the current buffer has unsaved edits — gates flush-on-leave so
  // navigating past an unchanged note issues no redundant write.
  const dirtyRef = useRef(false);
  const textareaRef = useRef<any>(null);
  const dropdownRef = useRef<any>(null);
  const columnsCacheRef = useRef<any>(null); // cached board columns for ticket creation
  // Attachment upload controller. All entry points (paste, drop, toolbar) feed a
  // single serialized queue so overlapping actions never race on the insertion
  // cursor, interleave markdown, or clear the "Uploading…" indicator early.
  //   attachActionsRef — every pending attachment as a SELF-CONTAINED action:
  //                      { file, gen, range }. Each action captures its OWN caret
  //                      range at the moment its paste/drop/pick happened, so two
  //                      independent actions insert at their own cursors — not one
  //                      shared advancing offset. `gen` (draftGen) binds the
  //                      action to its edit-session: a stale gen is discarded,
  //                      never inserted into the wrong note. Every action's range
  //                      is transformed as the buffer changes (user typing OR a
  //                      sibling attachment inserting), so anchors stay correct.
  //   attachBusyRef    — true while the single drain loop is running (mutex).
  //   insertingActionRef — the action currently being inserted; its OWN edit must
  //                      not transform its own range (only its siblings').
  const attachActionsRef = useRef<
    { file: any; gen: number; range: { start: number; end: number }; uploading?: boolean }[]
  >([]);
  const attachBusyRef = useRef(false);
  const insertingActionRef = useRef<any>(null);
  // Mirror volatile in-flight flags into refs so the memoized markdown
  // components (below) can read the live value for `disabled` without being
  // rebuilt on every scoping/ticketing toggle (which would remount the preview).
  const scopingRef = useRef(false);
  const ticketingRef = useRef(false);
  scopingRef.current = scoping;
  ticketingRef.current = ticketing;

  const fetchNotes = useCallback(
    async (query: any = '') => {
      if (!projectId) return;
      try {
        const data = await api.getNotes(projectId, query || undefined);
        setNotes(data);
      } catch (err: any) {
        console.error('Failed to fetch notes:', err);
      }
    },
    [projectId],
  );

  const fetchNote = useCallback(
    async (noteId: any) => {
      if (!projectId || !noteId) return;
      try {
        const data = await api.getNote(projectId, noteId);
        setSelectedNote(data);
      } catch (err: any) {
        console.error('Failed to fetch note:', err);
      }
    },
    [projectId],
  );

  // Initial fetch
  useEffect(() => {
    fetchNotes(searchQuery);
  }, [projectId, fetchNotes]);

  // Debounced search
  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      fetchNotes(searchQuery);
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchQuery]);

  // Cleanup auto-save timer on unmount
  useEffect(() => {
    return () => clearTimeout(saveTimerRef.current);
  }, []);

  // Fetch selected note
  useEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
    if (selectedNoteId) {
      fetchNote(selectedNoteId);
    } else {
      setSelectedNote(null);
    }
  }, [selectedNoteId, fetchNote]);

  // Handle WS events via window custom events (dispatched from App.jsx)
  useEffect(() => {
    const handleUpdate = (e: any) => {
      if (e.detail?.projectId === projectId) {
        fetchNotes(searchQuery);
        if (selectedNoteId && e.detail?.note?.id === selectedNoteId) {
          fetchNote(selectedNoteId);
        }
      }
    };
    const handleDelete = (e: any) => {
      if (e.detail?.projectId === projectId) {
        fetchNotes(searchQuery);
        if (selectedNoteId === e.detail?.noteId) {
          setSelectedNoteId(null);
          setSelectedNote(null);
          setEditing(false);
        }
      }
    };
    window.addEventListener('note_update', handleUpdate);
    window.addEventListener('note_delete', handleDelete);
    return () => {
      window.removeEventListener('note_update', handleUpdate);
      window.removeEventListener('note_delete', handleDelete);
    };
  }, [projectId, selectedNoteId, searchQuery, fetchNotes, fetchNote]);

  // Close target dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: any) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowTargetDropdown(false);
      }
    };
    if (showTargetDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTargetDropdown]);

  const handleCreate = () => {
    // Persist whatever draft is currently open before abandoning it.
    flushCurrentDraft();
    draftGenRef.current += 1;
    creatingRef.current = true;
    editTitleRef.current = '';
    editContentRef.current = '';
    dirtyRef.current = false;
    setCreating(true);
    setEditing(true);
    setEditTitle('');
    setEditContent('');
    setPreviewMode('edit');
    setSelectedNoteId(null);
    setSelectedNote(null);
    setProcessResult(null);
    setScopeResult(null);
    setTicketResult(null);
    // Focus textarea after render
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleEdit = () => {
    if (!selectedNote) return;
    draftGenRef.current += 1;
    creatingRef.current = false;
    editTitleRef.current = selectedNote.title || '';
    editContentRef.current = selectedNote.content || '';
    dirtyRef.current = false;
    setEditing(true);
    setCreating(false);
    setEditTitle(selectedNote.title);
    setEditContent(selectedNote.content || '');
    setPreviewMode('edit');
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleCancel = () => {
    // "Done" on an existing note flushes pending edits; "Cancel" on a brand-new
    // note is an explicit discard, so we just drop the buffer.
    if (creatingRef.current) {
      clearTimeout(saveTimerRef.current);
    } else {
      flushCurrentDraft();
    }
    draftGenRef.current += 1;
    dirtyRef.current = false;
    setEditing(false);
    setCreating(false);
    creatingRef.current = false;
  };

  // Drain the write queue one entry at a time. Each snapshot carries its own
  // target, so navigation/generation changes never redirect a queued write.
  // A snapshot captured while its draft's create was still in flight arrives
  // tagged `kind: 'create'`; once that create resolves we know the new id and
  // rewrite it to an update, so the later buffer lands on the created note.
  const drainWrites = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setSaving(true);
    try {
      while (writeQueueRef.current.length > 0) {
        let snap = writeQueueRef.current.shift();
        // A create for a draft that has already been created (an earlier queued
        // create for the same generation) becomes an update to that new note.
        if (snap.kind === 'create' && createdIdByGenRef.current.has(snap.gen)) {
          snap = { ...snap, kind: 'update', noteId: createdIdByGenRef.current.get(snap.gen) };
        }
        const title = deriveNoteTitle(snap.rawTitle, snap.content);
        try {
          if (snap.kind === 'create') {
            if (!snap.rawTitle.trim() && !snap.content.trim()) continue;
            createDispatchedGensRef.current.add(snap.gen);
            const note = await api.createNote(projectId, { title, content: snap.content });
            createdIdByGenRef.current.set(snap.gen, note.id);
            // Only adopt the created note as the active selection if the user
            // has not moved on; otherwise it is persisted without hijacking nav.
            if (snap.gen === draftGenRef.current) {
              creatingRef.current = false;
              selectedNoteIdRef.current = note.id;
              setCreating(false);
              setSelectedNoteId(note.id);
              setSelectedNote(note);
              // Backfill the derived title only when the note began title-less,
              // the field is still blank, AND the content still matches the
              // snapshot this title was derived from. If the title was
              // typed/cleared or the content changed during the POST, the
              // response title is stale — leave the field blank so the trailing
              // update re-derives from the latest content instead of writing a
              // stale title back into the buffer.
              if (
                snap.titleBlankAtStart &&
                !editTitleRef.current.trim() &&
                editContentRef.current === snap.content
              ) {
                editTitleRef.current = note.title;
                setEditTitle(note.title);
              }
            }
            fetchNotes(searchQuery);
          } else if (snap.noteId) {
            const note = await api.updateNote(projectId, snap.noteId, {
              title,
              content: snap.content,
            });
            if (snap.gen === draftGenRef.current) setSelectedNote(note);
            fetchNotes(searchQuery);
          }
        } catch (err: any) {
          console.error('Auto-save failed:', err);
        }
      }
    } finally {
      drainingRef.current = false;
      setSaving(false);
    }
  }, [projectId, searchQuery, fetchNotes]);

  // Capture a self-contained snapshot of the current buffer and enqueue it.
  // Writes for the same draft (generation) coalesce to the latest buffer;
  // writes for different drafts are preserved as separate queued entries.
  const enqueueWrite = useCallback(() => {
    const snap = {
      gen: draftGenRef.current,
      kind: creatingRef.current ? 'create' : 'update',
      noteId: selectedNoteIdRef.current,
      rawTitle: editTitleRef.current,
      content: editContentRef.current,
      titleBlankAtStart: !editTitleRef.current.trim(),
    };
    // Drop a truly-empty brand-new note, but NOT when a create for this draft
    // is already in flight/done: there the empty buffer is a clear that must be
    // persisted (drainWrites rewrites it to an update once the id is known).
    if (
      snap.kind === 'create' &&
      !snap.rawTitle.trim() &&
      !snap.content.trim() &&
      !createDispatchedGensRef.current.has(snap.gen)
    ) {
      return;
    }
    if (snap.kind === 'update' && !snap.noteId) return;
    dirtyRef.current = false;
    const q = writeQueueRef.current;
    if (q.length > 0 && q[q.length - 1].gen === snap.gen) {
      q[q.length - 1] = snap; // same draft still queued — keep only the latest
    } else {
      q.push(snap);
    }
    void drainWrites();
  }, [drainWrites]);

  const scheduleAutoSave = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      enqueueWrite();
    }, 700);
  }, [enqueueWrite]);

  // Persist the current draft's buffer immediately, cancelling any pending
  // debounce. Must run BEFORE the caller bumps the generation or repoints the
  // selection refs, because it snapshots the live refs — which still describe
  // the outgoing draft at call time. Only fires when the buffer is dirty, so
  // navigating past an unchanged note issues no redundant write. This is what
  // prevents a note typed within the 700ms window (or edits made while a save
  // was already in flight) from being lost when the user navigates away.
  const flushCurrentDraft = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    if (dirtyRef.current) enqueueWrite();
  }, [enqueueWrite]);

  // Explicit save (Create button / Cmd+S) — flush immediately, bypass debounce.
  const handleSave = () => {
    clearTimeout(saveTimerRef.current);
    enqueueWrite();
  };

  const handleContentChange = (value: any) => {
    // Keep every pending attachment anchor for the CURRENT edit-session aligned
    // with the edit just made — whether that edit is the user typing/deleting or
    // a sibling attachment inserting its snippet — so each upload still lands at
    // the intended logical spot. The action currently inserting is skipped: its
    // own edit must not move its own (already-consumed) range, only its siblings.
    const oldText = editContentRef.current || '';
    for (const action of attachActionsRef.current) {
      if (action.gen !== draftGenRef.current) continue;
      if (action === insertingActionRef.current) continue;
      action.range = transformRange(action.range, oldText, value || '');
    }
    setEditContent(value);
    editContentRef.current = value;
    dirtyRef.current = true;
    if (editing) scheduleAutoSave();
  };

  const handleTitleChange = (value: any) => {
    setEditTitle(value);
    editTitleRef.current = value;
    dirtyRef.current = true;
    if (editing) scheduleAutoSave();
  };

  // Insert a markdown snippet into the content buffer at a fixed offset
  // (replacing the [start, end) range), then move the caret past the snippet.
  // The offsets are captured up front (see handleAttachFiles) rather than read
  // from the live textarea, so an upload that resolves after the user has typed
  // or moved the caret still lands where the paste/drop/attach was initiated.
  // Returns the caret position after the inserted snippet so serial inserts can
  // advance from it.
  const insertSnippetAt = (snippet: any, start: number, end: number) => {
    const { text, cursor } = insertAtSelection(editContentRef.current || '', snippet, start, end);
    handleContentChange(text);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = cursor;
      }
    }, 0);
    return cursor;
  };

  // Upload one file and return its markdown snippet. Images go through
  // /api/upload (base64 data URL); other files through the binary
  // /api/upload/file. Both return `{ url: '/uploads/<file>' }`. This does NO
  // buffer mutation — insertion happens in the drain, AFTER re-checking the
  // edit-session, so a slow upload can't write into a note the user left.
  const uploadOne = async (file: any): Promise<string> => {
    const isImage =
      (file.type && String(file.type).startsWith('image/')) ||
      (!file.type && /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif)$/i.test(file.name || ''));
    let res: any;
    if (isImage) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.readAsDataURL(file);
      });
      res = await api.uploadImage(dataUrl, file.name || 'image.png');
    } else {
      res = await api.uploadFile(file);
    }
    if (!res?.url) throw new Error('Upload returned no URL');
    return buildAttachmentMarkdown({ name: file.name, url: res.url, contentType: file.type });
  };

  const dropAction = (action: any) => {
    attachActionsRef.current = attachActionsRef.current.filter((a) => a !== action);
  };

  // Drain pending attachment actions one at a time. Only ever one drain runs (the
  // attachBusyRef mutex), so uploads never overlap and the indicator stays lit
  // until nothing is pending. Each action carries its own captured range and the
  // edit-session (draftGen) it belongs to; an action whose gen no longer matches
  // the active draft is discarded rather than inserted, both before and after its
  // upload await — so switching/closing the note mid-upload never corrupts the
  // new buffer. The action's range has meanwhile been kept current by
  // handleContentChange, so it lands where the user intended even after edits.
  const drainAttachQueue = async () => {
    setUploading(true);
    try {
      // Pick the first not-yet-started action each pass (new actions can be
      // appended mid-drain and are picked up here).
      for (;;) {
        const action = attachActionsRef.current.find((a) => !a.uploading);
        if (!action) break;
        if (action.gen !== draftGenRef.current) {
          dropAction(action);
          continue; // note/edit-session changed before this ran — drop it
        }
        action.uploading = true;
        try {
          const snippet = await uploadOne(action.file);
          // Re-check AFTER the await: the user may have navigated during upload.
          if (action.gen !== draftGenRef.current) {
            dropAction(action);
            continue;
          }
          // Insert at this action's OWN (edit-tracked) range. Mark it as the
          // inserting action so its own insertion edit transforms only siblings.
          insertingActionRef.current = action;
          insertSnippetAt(snippet, action.range.start, action.range.end);
          insertingActionRef.current = null;
          dropAction(action);
        } catch (err: any) {
          insertingActionRef.current = null;
          if (action.gen === draftGenRef.current) setUploadError(err?.message || 'Upload failed');
          dropAction(action);
        }
      }
    } finally {
      attachBusyRef.current = false;
      setUploading(false);
    }
  };

  // Entry point for every attach source (paste, drop, toolbar). Captures THIS
  // action's caret range from the live selection right now (before any await, so
  // it replaces a selection like a normal paste and reflects where THIS action
  // happened — not where an earlier one left the cursor), tags it with the
  // current edit-session (draftGen), and starts the drain if idle. Each file
  // becomes its own action with its own range copy, so independent actions insert
  // at independent cursors while every pending range tracks later edits.
  const handleAttachFiles = (files: any) => {
    const list = Array.from(files || []).filter(Boolean);
    if (list.length === 0) return;
    const gen = draftGenRef.current;
    const ta = textareaRef.current;
    const len = (editContentRef.current || '').length;
    let range: { start: number; end: number };
    if (ta && typeof ta.selectionStart === 'number') {
      const a = ta.selectionStart;
      const b = ta.selectionEnd ?? a;
      range = { start: Math.min(a, b), end: Math.max(a, b) };
    } else {
      range = { start: len, end: len };
    }
    // Each file gets its OWN range object (same starting value). When the first
    // inserts, handleContentChange shifts the rest so they follow it in order.
    for (const file of list) {
      attachActionsRef.current.push({ file, gen, range: { ...range } });
    }
    if (attachBusyRef.current) return; // a drain is running — it will pick these up
    attachBusyRef.current = true;
    setUploadError('');
    void drainAttachQueue();
  };

  const handlePaste = (e: any) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const media = Array.from(items).filter(
      (it: any) => it.kind === 'file' && it.type && it.type.startsWith('image/'),
    );
    if (media.length === 0) return; // let normal text paste through
    e.preventDefault();
    const files = media.map((it: any) => it.getAsFile()).filter(Boolean);
    handleAttachFiles(files);
  };

  const handleContentDragOver = (e: any) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  };

  const handleContentDrop = (e: any) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    handleAttachFiles(e.dataTransfer.files);
  };

  const handleFileInputChange = (e: any) => {
    if (e.target.files?.length) handleAttachFiles(e.target.files);
    e.target.value = '';
  };

  const handleDelete = async (noteId: any) => {
    try {
      await api.deleteNote(projectId, noteId);
      setDeleteConfirm(null);
      if (selectedNoteId === noteId) {
        setSelectedNoteId(null);
        setSelectedNote(null);
        setEditing(false);
      }
      fetchNotes(searchQuery);
    } catch (err: any) {
      console.error('Failed to delete note:', err);
    }
  };

  const handleProcess = async () => {
    if (!selectedNote || processing) return;
    setProcessing(true);
    setProcessResult(null);
    try {
      // Use today's date as the processing date
      const today = new Date().toISOString().split('T')[0];
      const result = await api.processNote(projectId, today, {
        target: processTarget,
        excerpt: selectedNote.content,
      });
      setProcessResult({
        status: 'success',
        message: `Processing started (${processTarget}). Session: ${result.session_id?.slice(0, 8)}...`,
      });
    } catch (err: any) {
      setProcessResult({
        status: 'error',
        message: err.message || 'Failed to start processing',
      });
    } finally {
      setProcessing(false);
    }
  };

  // Start a scoping session seeded with `content`. Used both for the whole note
  // and for a single heading-scoped block (via the button next to a heading).
  const handleScopeContent = useCallback(
    async (content: any, title: any) => {
      // Guard via ref (not the `scoping` state) so this callback keeps a stable
      // identity across scoping toggles — the memoized markdown components
      // depend on it and must not be rebuilt (and remounted) on click.
      if (!content || !String(content).trim() || scopingRef.current) return;
      setScoping(true);
      setScopeResult(null);
      try {
        const result = await api.scopeFromNotes(projectId, {
          content: String(content),
          title: title || undefined,
        });
        setScopeResult({
          status: 'success',
          message: `Scoping session started${title ? ` for "${title}"` : ''}. Session: ${result.sessionId?.slice(0, 8)}...`,
        });
      } catch (err: any) {
        setScopeResult({
          status: 'error',
          message: err.message || 'Failed to start scoping session',
        });
      } finally {
        setScoping(false);
      }
    },
    [projectId],
  );

  const handleScopeWholeNote = () => {
    if (!selectedNote) return;
    handleScopeContent(selectedNote.content, selectedNote.title);
  };

  // Resolve the board's "To Do" column (falling back to the first column),
  // caching the columns so repeated line-item conversions don't refetch.
  const resolveTodoColumn = useCallback(async () => {
    if (!columnsCacheRef.current) {
      const board = await api.getBoard(projectId, { limit: 'all' });
      columnsCacheRef.current = board?.columns || [];
    }
    return pickTodoColumn(columnsCacheRef.current || []);
  }, [projectId]);

  // Convert a single line item into a kanban ticket in the To Do column. The
  // server dedupes by title, so double-clicks return the same card. Guards via
  // ref so the callback identity stays stable (see handleScopeContent).
  const handleConvertToTicket = useCallback(
    async (title: any) => {
      const t = (title || '').replace(/\s+/g, ' ').trim();
      if (!t || ticketingRef.current) return;
      setTicketing(true);
      setTicketResult(null);
      try {
        const column = await resolveTodoColumn();
        if (!column) throw new Error('No board column available');
        await api.createCard(projectId, { title: t, columnId: column.id });
        const short = t.length > 60 ? `${t.slice(0, 60)}…` : t;
        setTicketResult({ status: 'success', message: `Ticket created: "${short}"` });
      } catch (err: any) {
        setTicketResult({ status: 'error', message: err.message || 'Failed to create ticket' });
      } finally {
        setTicketing(false);
      }
    },
    [projectId, resolveTodoColumn],
  );

  // Handle keyboard shortcuts in textarea
  const handleKeyDown = (e: any) => {
    // Cmd/Ctrl+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    // Tab for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.target;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      handleContentChange(newValue);
      // Restore cursor position
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  // Normalize the selected note's content once, and derive the scope/ticket
  // components from it. Both are memoized so react-markdown receives stable
  // component identities across re-renders (including scoping/ticketing toggles,
  // which read their flags via refs) — otherwise the whole preview subtree would
  // remount and re-parse on every click. The slice runs against the SAME
  // normalized string react-markdown parsed, so heading line numbers line up.
  const viewNormalized = useMemo(
    () => normalizeNotesMarkdown(selectedNote?.content || ''),
    [selectedNote?.content],
  );
  const scopeComponents = useMemo(
    () =>
      makeScopeComponents(viewNormalized, {
        onScope: handleScopeContent,
        onTicket: handleConvertToTicket,
        scopingRef,
        ticketingRef,
        noteTitle: selectedNote?.title,
      }),
    [viewNormalized, handleScopeContent, handleConvertToTicket, selectedNote?.title],
  );

  const renderMarkdownPreview = (content: any, components?: any) => (
    <div className="prose prose-invert prose-sm max-w-none text-gray-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components || mediaMarkdownComponents}>
        {normalizeNotesMarkdown(content || '')}
      </ReactMarkdown>
    </div>
  );

  const selectedTarget = PROCESS_TARGETS.find((t: any) => t.value === processTarget);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left panel — note list */}
      <div className="w-[280px] flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
        {/* Header */}
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <StickyNote size={16} />
              Notes
            </h2>
            <button
              onClick={handleCreate}
              className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800 transition-colors"
              title="New Note"
            >
              <Plus size={16} />
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e: any) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600"
            />
          </div>
        </div>

        {/* Note list */}
        <div className="flex-1 overflow-y-auto">
          {notes.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {searchQuery ? 'No notes match your search.' : 'No notes yet.'}
            </div>
          ) : (
            notes.map((note: any) => (
              <div
                key={note.id}
                onMouseEnter={() => setHoveredNoteId(note.id)}
                onMouseLeave={() => {
                  setHoveredNoteId(null);
                  if (deleteConfirm === note.id) setDeleteConfirm(null);
                }}
                onClick={() => {
                  // Persist the current draft before switching away — otherwise
                  // a note typed within the debounce window would be lost.
                  flushCurrentDraft();
                  draftGenRef.current += 1;
                  creatingRef.current = false;
                  dirtyRef.current = false;
                  setSelectedNoteId(note.id);
                  setEditing(false);
                  setCreating(false);
                  setProcessResult(null);
                  setScopeResult(null);
                  setTicketResult(null);
                  columnsCacheRef.current = null;
                }}
                className={`px-3 py-2.5 cursor-pointer border-b border-gray-800/50 transition-colors ${
                  selectedNoteId === note.id
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{note.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-500">{relativeTime(note.updated_at)}</span>
                      {note.snippet && <SnippetText snippet={note.snippet} />}
                    </div>
                  </div>
                  {hoveredNoteId === note.id && (
                    <div className="flex-shrink-0">
                      {deleteConfirm === note.id ? (
                        <button
                          onClick={(e: any) => {
                            e.stopPropagation();
                            handleDelete(note.id);
                          }}
                          className="text-xs text-red-400 hover:text-red-300 px-1"
                        >
                          Confirm?
                        </button>
                      ) : (
                        <button
                          onClick={(e: any) => {
                            e.stopPropagation();
                            setDeleteConfirm(note.id);
                          }}
                          className="text-gray-600 hover:text-red-400 p-0.5 transition-colors"
                          title="Delete note"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel — editor / viewer */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900">
        {editing ? (
          /* Edit / Create mode */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-200">
                  {creating ? 'New Note' : 'Editing'}
                </h2>
                {saving && <span className="text-xs text-gray-500 animate-pulse">Saving...</span>}
                {!saving && !creating && selectedNoteId && (
                  <span className="text-xs text-gray-600">Auto-saved</span>
                )}
                {uploading && (
                  <span className="text-xs text-blue-400 animate-pulse">Uploading…</span>
                )}
                {uploadError && <span className="text-xs text-red-400">{uploadError}</span>}
              </div>
              <div className="flex items-center gap-1">
                {/* Attach image / file — no `accept` filter so the toolbar can
                    pick any file type (PDFs, etc.), matching drag-drop, which
                    accepts all files. Images embed inline; others link. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="p-1.5 rounded transition-colors text-gray-500 hover:text-gray-300 disabled:opacity-50"
                  title="Attach image or file (or paste / drag one in)"
                  aria-label="Attach image or file"
                >
                  {uploading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ImagePlus size={14} />
                  )}
                </button>

                <div className="w-px h-4 bg-gray-700 mx-1" />

                {/* View mode toggle */}
                <button
                  onClick={() => setPreviewMode('edit')}
                  className={`p-1.5 rounded transition-colors ${previewMode === 'edit' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  title="Edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setPreviewMode('split')}
                  className={`p-1.5 rounded transition-colors ${previewMode === 'split' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  title="Split view"
                >
                  <SplitSquareHorizontal size={14} />
                </button>
                <button
                  onClick={() => setPreviewMode('preview')}
                  className={`p-1.5 rounded transition-colors ${previewMode === 'preview' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  title="Preview"
                >
                  <Eye size={14} />
                </button>

                <div className="w-px h-4 bg-gray-700 mx-1" />

                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-sm text-gray-400 hover:text-white rounded hover:bg-gray-800 transition-colors"
                >
                  <X size={14} />
                  {creating ? 'Cancel' : 'Done'}
                </button>
                {creating && (
                  <button
                    onClick={handleSave}
                    disabled={!editTitle.trim() && !editContent.trim()}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Save size={14} />
                    Create
                  </button>
                )}
              </div>
            </div>

            {/* Title input */}
            <div className="px-4 pt-4 pb-2">
              <input
                type="text"
                value={editTitle}
                onChange={(e: any) => handleTitleChange(e.target.value)}
                placeholder="Note title..."
                className="w-full bg-transparent border-none text-xl font-semibold text-gray-100 placeholder-gray-600 focus:outline-none"
              />
            </div>

            {/* Content area */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {(previewMode === 'edit' || previewMode === 'split') && (
                <div
                  className={`flex-1 flex flex-col min-w-0 ${previewMode === 'split' ? 'border-r border-gray-800' : ''}`}
                >
                  <textarea
                    ref={textareaRef}
                    value={editContent}
                    onChange={(e: any) => handleContentChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onDragOver={handleContentDragOver}
                    onDrop={handleContentDrop}
                    placeholder="Start writing... (Markdown supported — paste an image, or drop a file, to attach)"
                    className="flex-1 w-full bg-transparent px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none resize-none font-mono leading-relaxed"
                  />
                </div>
              )}
              {(previewMode === 'preview' || previewMode === 'split') && (
                <div className="flex-1 overflow-y-auto px-6 py-2">
                  {renderMarkdownPreview(editContent)}
                </div>
              )}
            </div>
          </div>
        ) : selectedNote ? (
          /* View mode */
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="px-6 pt-6 pb-4 border-b border-gray-800">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-xl font-semibold text-gray-100">{selectedNote.title}</h1>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-gray-500">
                      Updated {relativeTime(selectedNote.updated_at)}
                    </span>
                    <span className="text-xs text-gray-600">
                      Created {relativeTime(selectedNote.created_at)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Process note dropdown */}
                  <div className="relative" ref={dropdownRef}>
                    <div className="flex items-center">
                      <button
                        onClick={handleProcess}
                        disabled={processing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded-l-lg transition-colors disabled:opacity-50"
                        title={`Process note: ${selectedTarget?.label}`}
                      >
                        {processing ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Zap size={14} />
                        )}
                        Process
                      </button>
                      <button
                        onClick={() => setShowTargetDropdown((prev: any) => !prev)}
                        className="flex items-center px-1.5 py-1.5 text-sm bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded-r-lg border-l border-purple-600/30 transition-colors"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    {showTargetDropdown && (
                      <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 py-1">
                        {PROCESS_TARGETS.map((target: any) => (
                          <button
                            key={target.value}
                            onClick={() => {
                              setProcessTarget(target.value);
                              setShowTargetDropdown(false);
                            }}
                            className={`w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors ${
                              processTarget === target.value
                                ? 'bg-gray-700/50 text-white'
                                : 'text-gray-300'
                            }`}
                          >
                            <div className="text-sm font-medium">{target.label}</div>
                            <div className="text-xs text-gray-500">{target.desc}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={handleScopeWholeNote}
                    disabled={scoping}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors disabled:opacity-50"
                    title="Scope this whole note into a planning session (epic → phases → tickets)"
                  >
                    {scoping ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Telescope size={14} />
                    )}
                    Scope
                  </button>

                  <button
                    onClick={handleEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
                  >
                    <Pencil size={14} />
                    Edit
                  </button>
                </div>
              </div>

              {/* Process result feedback */}
              {processResult && (
                <div
                  className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                    processResult.status === 'success'
                      ? 'bg-green-900/20 text-green-400'
                      : 'bg-red-900/20 text-red-400'
                  }`}
                >
                  {processResult.status === 'success' ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {processResult.message}
                </div>
              )}

              {/* Scope result feedback */}
              {scopeResult && (
                <div
                  className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                    scopeResult.status === 'success'
                      ? 'bg-green-900/20 text-green-400'
                      : 'bg-red-900/20 text-red-400'
                  }`}
                >
                  {scopeResult.status === 'success' ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {scopeResult.message}
                </div>
              )}

              {/* Ticket (line-item → card) result feedback */}
              {ticketResult && (
                <div
                  className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                    ticketResult.status === 'success'
                      ? 'bg-green-900/20 text-green-400'
                      : 'bg-red-900/20 text-red-400'
                  }`}
                >
                  {ticketResult.status === 'success' ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {ticketResult.message}
                </div>
              )}
            </div>
            <div className="px-6 py-4 flex-1">
              {renderMarkdownPreview(selectedNote.content, scopeComponents)}
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 px-8">
            <StickyNote size={48} className="mb-4" />
            <p className="text-lg font-medium text-gray-400 mb-2">Notes</p>
            <p className="text-sm text-center max-w-md">
              Quick-capture notes with rich Markdown editing. Use split view for live preview, or
              just write — notes auto-save as you type.
            </p>
            <p className="text-xs text-center max-w-md mt-2 text-gray-600">
              Process notes through an agent to extract knowledge into wiki pages, memory, or kanban
              cards.
            </p>
            {notes.length === 0 && (
              <button
                onClick={handleCreate}
                className="mt-6 flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors text-sm"
              >
                <Plus size={16} />
                Create your first note
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
