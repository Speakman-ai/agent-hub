import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { BookOpen, Search, Plus, Trash2, Pencil, Save, X } from 'lucide-react';
import { getAuthHeaders } from '../utils/connection.js';

const CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'general', label: 'General' },
  { value: 'api-docs', label: 'API Docs' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'conventions', label: 'Conventions' },
  { value: 'test-patterns', label: 'Test Patterns' },
  { value: 'troubleshooting', label: 'Troubleshooting' },
  { value: 'onboarding', label: 'Onboarding' },
];

const CATEGORY_COLORS = {
  general: 'bg-gray-600 text-gray-200',
  'api-docs': 'bg-blue-600 text-blue-100',
  architecture: 'bg-purple-600 text-purple-100',
  conventions: 'bg-amber-600 text-amber-100',
  'test-patterns': 'bg-green-600 text-green-100',
  troubleshooting: 'bg-red-600 text-red-100',
  onboarding: 'bg-teal-600 text-teal-100',
};

function getCategoryBadge(category) {
  const colors = CATEGORY_COLORS[category] || 'bg-gray-600 text-gray-200';
  const label = CATEGORIES.find((c) => c.value === category)?.label || category;
  return <span className={`text-xs px-1.5 py-0.5 rounded ${colors}`}>{label}</span>;
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
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

export default function WikiBrowser({ projectId, apiBase }) {
  const [pages, setPages] = useState([]);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [selectedPage, setSelectedPage] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('general');
  const [_loading, setLoading] = useState(false);
  const [hoveredSlug, setHoveredSlug] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const searchTimerRef = useRef(null);

  const fetchPages = useCallback(
    async (query = '', category = '') => {
      if (!projectId) return;
      try {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (category && category !== 'all') params.set('category', category);
        const qs = params.toString();
        const url = `${apiBase}/projects/${projectId}/wiki${qs ? '?' + qs : ''}`;
        const res = await fetch(url, { headers: getAuthHeaders() });
        if (res.ok) {
          const data = await res.json();
          setPages(data);
        }
      } catch (err) {
        console.error('Failed to fetch wiki pages:', err);
      }
    },
    [projectId, apiBase],
  );

  const fetchPage = useCallback(
    async (slug) => {
      if (!projectId || !slug) return;
      try {
        setLoading(true);
        const res = await fetch(`${apiBase}/projects/${projectId}/wiki/${slug}`, {
          headers: getAuthHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setSelectedPage(data);
        }
      } catch (err) {
        console.error('Failed to fetch wiki page:', err);
      } finally {
        setLoading(false);
      }
    },
    [projectId, apiBase],
  );

  // Initial fetch
  useEffect(() => {
    fetchPages(searchQuery, activeCategory);
  }, [projectId, activeCategory, fetchPages]);

  // Debounced search
  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      fetchPages(searchQuery, activeCategory);
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchQuery]);

  // Fetch selected page
  useEffect(() => {
    if (selectedSlug) {
      fetchPage(selectedSlug);
    } else {
      setSelectedPage(null);
    }
  }, [selectedSlug, fetchPage]);

  // Handle wiki WS events via window custom events (dispatched from App.jsx)
  useEffect(() => {
    const handleUpdate = (e) => {
      if (e.detail?.projectId === projectId) {
        fetchPages(searchQuery, activeCategory);
        if (selectedSlug && e.detail?.page?.slug === selectedSlug) {
          fetchPage(selectedSlug);
        }
      }
    };
    const handleDelete = (e) => {
      if (e.detail?.projectId === projectId) {
        fetchPages(searchQuery, activeCategory);
        if (selectedSlug === e.detail?.slug) {
          setSelectedSlug(null);
          setSelectedPage(null);
        }
      }
    };
    window.addEventListener('wiki_update', handleUpdate);
    window.addEventListener('wiki_delete', handleDelete);
    return () => {
      window.removeEventListener('wiki_update', handleUpdate);
      window.removeEventListener('wiki_delete', handleDelete);
    };
  }, [projectId, selectedSlug, searchQuery, activeCategory, fetchPages, fetchPage]);

  const handleCreate = () => {
    setCreating(true);
    setEditing(true);
    setEditTitle('');
    setEditContent('');
    setEditCategory('general');
    setSelectedSlug(null);
    setSelectedPage(null);
  };

  const handleEdit = () => {
    if (!selectedPage) return;
    setEditing(true);
    setCreating(false);
    setEditTitle(selectedPage.title);
    setEditContent(selectedPage.content || '');
    setEditCategory(selectedPage.category || 'general');
  };

  const handleCancel = () => {
    setEditing(false);
    setCreating(false);
  };

  const handleSave = async () => {
    if (!editTitle.trim()) return;
    try {
      if (creating) {
        const res = await fetch(`${apiBase}/projects/${projectId}/wiki`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ title: editTitle, content: editContent, category: editCategory }),
        });
        if (res.ok) {
          const page = await res.json();
          setEditing(false);
          setCreating(false);
          await fetchPages(searchQuery, activeCategory);
          setSelectedSlug(page.slug);
        }
      } else if (selectedSlug) {
        const res = await fetch(`${apiBase}/projects/${projectId}/wiki/${selectedSlug}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ title: editTitle, content: editContent, category: editCategory }),
        });
        if (res.ok) {
          const page = await res.json();
          setEditing(false);
          setSelectedPage(page);
          fetchPages(searchQuery, activeCategory);
        }
      }
    } catch (err) {
      console.error('Failed to save wiki page:', err);
    }
  };

  const handleDelete = async (slug) => {
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/wiki/${slug}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        setDeleteConfirm(null);
        if (selectedSlug === slug) {
          setSelectedSlug(null);
          setSelectedPage(null);
          setEditing(false);
        }
        fetchPages(searchQuery, activeCategory);
      }
    } catch (err) {
      console.error('Failed to delete wiki page:', err);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left panel — page list */}
      <div className="w-[300px] flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
        {/* Header */}
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <BookOpen size={16} />
              Wiki
            </h2>
            <button
              onClick={handleCreate}
              className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800 transition-colors"
              title="New Page"
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
              placeholder="Search pages..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600"
            />
          </div>
        </div>

        {/* Category tabs */}
        <div className="px-3 py-2 border-b border-gray-800 overflow-x-auto flex gap-1 scrollbar-hide">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => setActiveCategory(cat.value)}
              className={`text-xs px-2 py-1 rounded-full whitespace-nowrap transition-colors ${
                activeCategory === cat.value
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Page list */}
        <div className="flex-1 overflow-y-auto">
          {pages.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {searchQuery || activeCategory !== 'all'
                ? 'No pages match your filters.'
                : 'No wiki pages yet.'}
            </div>
          ) : (
            pages.map((page) => (
              <div
                key={page.slug}
                onMouseEnter={() => setHoveredSlug(page.slug)}
                onMouseLeave={() => {
                  setHoveredSlug(null);
                  if (deleteConfirm === page.slug) setDeleteConfirm(null);
                }}
                onClick={() => {
                  setSelectedSlug(page.slug);
                  setEditing(false);
                  setCreating(false);
                }}
                className={`px-3 py-2.5 cursor-pointer border-b border-gray-800/50 transition-colors ${
                  selectedSlug === page.slug
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{page.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      {getCategoryBadge(page.category)}
                      <span className="text-xs text-gray-500">{relativeTime(page.updated_at)}</span>
                      {page.updated_by && (
                        <span className="text-xs text-gray-600 truncate">{page.updated_by}</span>
                      )}
                    </div>
                  </div>
                  {hoveredSlug === page.slug && (
                    <div className="flex-shrink-0">
                      {deleteConfirm === page.slug ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(page.slug);
                          }}
                          className="text-xs text-red-400 hover:text-red-300 px-1"
                        >
                          Confirm?
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm(page.slug);
                          }}
                          className="text-gray-600 hover:text-red-400 p-0.5 transition-colors"
                          title="Delete page"
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

      {/* Right panel — viewer / editor */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900">
        {editing ? (
          /* Edit / Create mode */
          <div className="flex-1 flex flex-col p-6 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-200">
                {creating ? 'New Page' : 'Edit Page'}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!editTitle.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save size={14} />
                  Save
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Page title"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Category</label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-600"
                >
                  {CATEGORIES.filter((c) => c.value !== 'all').map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Content (Markdown)</label>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="Write your wiki page content in Markdown..."
                  className="w-full h-[calc(100vh-350px)] min-h-[300px] bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600 resize-none font-mono"
                />
              </div>
            </div>
          </div>
        ) : selectedPage ? (
          /* View mode */
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="p-6 border-b border-gray-800">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-xl font-semibold text-gray-100">{selectedPage.title}</h1>
                  <div className="flex items-center gap-3 mt-2">
                    {getCategoryBadge(selectedPage.category)}
                    <span className="text-xs text-gray-500">
                      Updated {relativeTime(selectedPage.updated_at)}
                    </span>
                    {selectedPage.updated_by && (
                      <span className="text-xs text-gray-500">by {selectedPage.updated_by}</span>
                    )}
                  </div>
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
            <div className="p-6 flex-1">
              <div className="prose prose-invert prose-sm max-w-none text-gray-300">
                <ReactMarkdown>{selectedPage.content || ''}</ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 px-8">
            <BookOpen size={48} className="mb-4" />
            <p className="text-lg font-medium text-gray-400 mb-2">Project Wiki</p>
            <p className="text-sm text-center max-w-md">
              A shared knowledge base for your team and agents. Document APIs, architecture
              decisions, conventions, troubleshooting guides, and onboarding notes.
            </p>
            {pages.length === 0 && (
              <button
                onClick={handleCreate}
                className="mt-6 flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors text-sm"
              >
                <Plus size={16} />
                Create your first page
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
