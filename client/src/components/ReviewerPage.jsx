import { useState, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import { ScanEye, FileText, Pencil, PenLine, Save, Loader2 } from 'lucide-react';

// Per-project page for editing the reviewer agent's markdown context files
// (served by the existing GET/PUT /api/agents/:agentId/context endpoints).
export default function ReviewerPage({ projectId, projects = [] }) {
  const project = useMemo(
    () => projects.find((p) => p.id === projectId) || null,
    [projects, projectId],
  );

  const reviewerAgent = useMemo(() => {
    const agents = project && Array.isArray(project.agents) ? project.agents : [];
    return agents.find((a) => a.role === 'reviewer') || null;
  }, [project]);

  const reviewerAgentId = reviewerAgent ? reviewerAgent.id : null;

  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!reviewerAgentId) {
      setContext(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContext(reviewerAgentId)
      .then((data) => {
        if (cancelled) return;
        setContext(data || {});
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err && err.message ? err.message : 'Failed to load reviewer files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewerAgentId]);

  const handleSaved = useCallback((filename, newContent) => {
    setContext((prev) => ({ ...(prev || {}), [filename]: newContent }));
  }, []);

  const fileEntries = context ? Object.entries(context) : [];

  return (
    <div className="h-full overflow-y-auto bg-gray-900 text-gray-100">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center gap-2.5 mb-1">
          <ScanEye size={22} className="text-emerald-400" />
          <h1 className="text-xl font-semibold">Reviewer</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          {project ? (
            <>
              Markdown files that shape the <span className="text-gray-300">{project.name}</span>{' '}
              reviewer. Edits are saved to the reviewer agent&apos;s workspace and take effect on
              its next review.
            </>
          ) : (
            'Select a project to view its reviewer files.'
          )}
        </p>

        {!project ? (
          <EmptyState message="Project not found." />
        ) : !reviewerAgent ? (
          <EmptyState message="This project has no reviewer yet. The reviewer agent is created automatically once the project has GitHub integration (a connected repo or an enabled webhook)." />
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
            <Loader2 size={16} className="animate-spin" /> Loading reviewer files…
          </div>
        ) : error ? (
          <EmptyState message={`Could not load reviewer files: ${error}`} />
        ) : fileEntries.length === 0 ? (
          <EmptyState message="No markdown files found for this reviewer." />
        ) : (
          <div className="space-y-2">
            {fileEntries.map(([filename, content]) => (
              <ReviewerFilePanel
                key={filename}
                filename={filename}
                content={content}
                agentId={reviewerAgentId}
                onSaved={handleSaved}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-6 text-sm text-gray-400">
      {message}
    </div>
  );
}

function ReviewerFilePanel({ filename, content, agentId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    setEditContent(content || '');
  }, [content]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err) {
      setSaveError(err && err.message ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (content === null || content === undefined) return null;

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div
        className="p-3 cursor-pointer hover:bg-gray-750 transition-colors flex items-center justify-between"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
          <FileText size={14} /> {filename}
        </span>
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(!editing);
              }}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                editing
                  ? 'bg-blue-800/50 text-blue-400'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              <span className="flex items-center gap-1">
                {editing ? (
                  <>
                    <PenLine size={12} /> Editing
                  </>
                ) : (
                  <>
                    <Pencil size={12} /> Edit
                  </>
                )}
              </span>
            </button>
            {editing && (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-xs bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
                >
                  <span className="flex items-center gap-1">
                    {saving ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> Saving...
                      </>
                    ) : (
                      <>
                        <Save size={12} /> Save
                      </>
                    )}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setEditContent(content || '');
                    setSaveError(null);
                    setEditing(false);
                  }}
                  disabled={saving}
                  className="text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            )}
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          </div>
          {editing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 font-mono focus:outline-none focus:border-gray-600 resize-y min-h-[200px]"
              rows={15}
            />
          ) : (
            <div className="prose prose-invert prose-sm max-w-none text-xs max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content || '*(empty)*'}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
