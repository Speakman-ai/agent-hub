import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeNotesMarkdown } from '../utils/notesMarkdown.js';
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
} from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Parse an FTS snippet string into an array of { text, bold } segments.
 * Strips all HTML except <b>...</b> highlight markers.
 */
function parseSnippet(html) {
  if (!html) return [];
  // Split on <b>...</b> pairs, capturing the bold content
  const parts = html.split(/(<b>.*?<\/b>)/gi);
  return parts
    .map((part) => {
      const boldMatch = part.match(/^<b>(.*?)<\/b>$/i);
      if (boldMatch) {
        return { text: stripTags(boldMatch[1]), bold: true };
      }
      return { text: stripTags(part), bold: false };
    })
    .filter((seg) => seg.text);
}

/** Strip all HTML tags and decode common entities */
function stripTags(str) {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Render sanitized snippet with bold highlights */
function SnippetText({ snippet }) {
  if (!snippet) return null;
  const segments = parseSnippet(snippet);
  if (segments.length === 0) return null;
  return (
    <span className="text-xs text-gray-600 truncate">
      {segments.map((seg, i) =>
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

function relativeTime(dateStr) {
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

export default function NotesEditor({ projectId }) {
  const [notes, setNotes] = useState([]);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [selectedNote, setSelectedNote] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [previewMode, setPreviewMode] = useState('edit'); // 'edit' | 'preview' | 'split'
  const [hoveredNoteId, setHoveredNoteId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [saving, setSaving] = useState(false);
  // Processing state
  const [processing, setProcessing] = useState(false);
  const [processTarget, setProcessTarget] = useState('auto');
  const [processResult, setProcessResult] = useState(null); // { status, message }
  const [showTargetDropdown, setShowTargetDropdown] = useState(false);
  const searchTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);

  const fetchNotes = useCallback(
    async (query = '') => {
      if (!projectId) return;
      try {
        const data = await api.getNotes(projectId, query || undefined);
        setNotes(data);
      } catch (err) {
        console.error('Failed to fetch notes:', err);
      }
    },
    [projectId],
  );

  const fetchNote = useCallback(
    async (noteId) => {
      if (!projectId || !noteId) return;
      try {
        const data = await api.getNote(projectId, noteId);
        setSelectedNote(data);
      } catch (err) {
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
    if (selectedNoteId) {
      fetchNote(selectedNoteId);
    } else {
      setSelectedNote(null);
    }
  }, [selectedNoteId, fetchNote]);

  // Handle WS events via window custom events (dispatched from App.jsx)
  useEffect(() => {
    const handleUpdate = (e) => {
      if (e.detail?.projectId === projectId) {
        fetchNotes(searchQuery);
        if (selectedNoteId && e.detail?.note?.id === selectedNoteId) {
          fetchNote(selectedNoteId);
        }
      }
    };
    const handleDelete = (e) => {
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
    const handleClickOutside = (e) => {
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
    setCreating(true);
    setEditing(true);
    setEditTitle('');
    setEditContent('');
    setPreviewMode('edit');
    setSelectedNoteId(null);
    setSelectedNote(null);
    setProcessResult(null);
    // Focus textarea after render
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleEdit = () => {
    if (!selectedNote) return;
    setEditing(true);
    setCreating(false);
    setEditTitle(selectedNote.title);
    setEditContent(selectedNote.content || '');
    setPreviewMode('edit');
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleCancel = () => {
    setEditing(false);
    setCreating(false);
    clearTimeout(saveTimerRef.current);
  };

  const handleSave = async () => {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      if (creating) {
        const note = await api.createNote(projectId, {
          title: editTitle,
          content: editContent,
        });
        setEditing(false);
        setCreating(false);
        await fetchNotes(searchQuery);
        setSelectedNoteId(note.id);
      } else if (selectedNoteId) {
        const note = await api.updateNote(projectId, selectedNoteId, {
          title: editTitle,
          content: editContent,
        });
        setSelectedNote(note);
        // Don't exit editing — keep user in edit mode for quick iteration
        fetchNotes(searchQuery);
      }
    } catch (err) {
      console.error('Failed to save note:', err);
    } finally {
      setSaving(false);
    }
  };

  // Auto-save on content change (debounced, only when editing an existing note)
  const handleContentChange = (value) => {
    setEditContent(value);
    if (!creating && selectedNoteId && editTitle.trim()) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          const note = await api.updateNote(projectId, selectedNoteId, {
            title: editTitle,
            content: value,
          });
          setSelectedNote(note);
          fetchNotes(searchQuery);
        } catch (err) {
          console.error('Auto-save failed:', err);
        } finally {
          setSaving(false);
        }
      }, 1000);
    }
  };

  const handleTitleChange = (value) => {
    setEditTitle(value);
    if (!creating && selectedNoteId && value.trim()) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          const note = await api.updateNote(projectId, selectedNoteId, {
            title: value,
            content: editContent,
          });
          setSelectedNote(note);
          fetchNotes(searchQuery);
        } catch (err) {
          console.error('Auto-save failed:', err);
        } finally {
          setSaving(false);
        }
      }, 1000);
    }
  };

  const handleDelete = async (noteId) => {
    try {
      await api.deleteNote(projectId, noteId);
      setDeleteConfirm(null);
      if (selectedNoteId === noteId) {
        setSelectedNoteId(null);
        setSelectedNote(null);
        setEditing(false);
      }
      fetchNotes(searchQuery);
    } catch (err) {
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
    } catch (err) {
      setProcessResult({
        status: 'error',
        message: err.message || 'Failed to start processing',
      });
    } finally {
      setProcessing(false);
    }
  };

  // Handle keyboard shortcuts in textarea
  const handleKeyDown = (e) => {
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

  const renderMarkdownPreview = (content) => (
    <div className="prose prose-invert prose-sm max-w-none text-gray-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeNotesMarkdown(content || '')}
      </ReactMarkdown>
    </div>
  );

  const selectedTarget = PROCESS_TARGETS.find((t) => t.value === processTarget);

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
              onChange={(e) => setSearchQuery(e.target.value)}
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
            notes.map((note) => (
              <div
                key={note.id}
                onMouseEnter={() => setHoveredNoteId(note.id)}
                onMouseLeave={() => {
                  setHoveredNoteId(null);
                  if (deleteConfirm === note.id) setDeleteConfirm(null);
                }}
                onClick={() => {
                  setSelectedNoteId(note.id);
                  setEditing(false);
                  setCreating(false);
                  setProcessResult(null);
                  clearTimeout(saveTimerRef.current);
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
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(note.id);
                          }}
                          className="text-xs text-red-400 hover:text-red-300 px-1"
                        >
                          Confirm?
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
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
              </div>
              <div className="flex items-center gap-1">
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
                    disabled={!editTitle.trim()}
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
                onChange={(e) => handleTitleChange(e.target.value)}
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
                    onChange={(e) => handleContentChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Start writing... (Markdown supported)"
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
                        onClick={() => setShowTargetDropdown((prev) => !prev)}
                        className="flex items-center px-1.5 py-1.5 text-sm bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded-r-lg border-l border-purple-600/30 transition-colors"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    {showTargetDropdown && (
                      <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 py-1">
                        {PROCESS_TARGETS.map((target) => (
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
            </div>
            <div className="px-6 py-4 flex-1">{renderMarkdownPreview(selectedNote.content)}</div>
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
