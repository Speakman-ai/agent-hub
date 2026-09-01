import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AlertTriangle, FileText, Loader2, PenLine, Pencil, RotateCw, Save } from 'lucide-react';
import { api } from '../utils/api';

export default function ContextFilePanel({
  filename,
  content,
  agentId,
  onSaved,
  hint,
  defaultExpanded = false,
  loading = false,
  error = false,
  onRetry,
}: any) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  // `content` is null until the requested agent's file has loaded. Only seed
  // the editor from a real string so a pending/errored read never becomes
  // editable empty text the user could save over an existing file.
  const [editContent, setEditContent] = useState(typeof content === 'string' ? content : '');
  // The token of the save that currently owns the "saving" indicator for the
  // mounted view. A per-request token (not a boolean, not an agent id) is the
  // only thing that survives overlapping saves and A->B->A round-trips.
  const [activeSaveToken, setActiveSaveToken] = useState<number | null>(null);
  const saving = activeSaveToken !== null;
  // User-facing save failure for the current view. Compare-and-swap conflicts
  // (409) are an expected outcome now, so the editor must tell the user their
  // buffer was NOT written and how to recover — not just log to the console.
  const [saveError, setSaveError] = useState<string | null>(null);

  const ready = !loading && !error && typeof content === 'string';

  // Root of every "state leaked across agents" bug flagged on this panel: the
  // component instance is reused across agents (and across separate visits to
  // the same agent), so transient editor state and in-flight saves must be
  // bound to a UNIQUE mounted-view identity, not to the agent id alone.
  //
  // `genRef` is that identity: a monotonic generation bumped synchronously
  // during render whenever `agentId` changes. A -> B -> A therefore yields
  // generations 0, 1, 2 — the second visit to A is a DIFFERENT generation, so
  // an A save started in generation 0 is correctly stale when it resolves.
  const genRef = useRef(0);
  const prevAgentIdRef = useRef(agentId);
  if (prevAgentIdRef.current !== agentId) {
    prevAgentIdRef.current = agentId;
    genRef.current += 1;
  }
  // Monotonic id handed to each save so an older request can never clear or
  // apply on behalf of a newer one, even within the same generation.
  const saveSeqRef = useRef(0);

  // Re-seed the editor from the loaded content whenever the content OR the
  // mounted agent changes. Resetting on `agentId` is what drops agent A's
  // unsaved buffer on a switch to agent B, even when both files have identical
  // content so `content` alone never changes.
  useEffect(() => {
    setEditContent(typeof content === 'string' ? content : '');
  }, [content, agentId]);

  // Close the editor when the file becomes unavailable (load/error) or the view
  // switches agents, and drop any pending-save indicator inherited from the
  // previous view. The underlying request is still tracked by token/generation,
  // so clearing the indicator here only affects THIS view's UI.
  useEffect(() => {
    setEditing(false);
  }, [ready, agentId]);
  useEffect(() => {
    setActiveSaveToken(null);
    setSaveError(null);
  }, [agentId]);

  const handleSave = async () => {
    if (!agentId || !ready) return;
    // Bind this save to the exact mounted view (generation) and give it a unique
    // token. Both are checked at completion so nothing stale applies or clears.
    const myGen = genRef.current;
    const myToken = (saveSeqRef.current += 1);
    const targetAgent = agentId;
    const buffer = editContent;
    // The content this edit was based on — the server uses it as a
    // compare-and-swap base so a stale/out-of-order save cannot overwrite a
    // newer commit on disk.
    const base = typeof content === 'string' ? content : '';
    setActiveSaveToken(myToken);
    setSaveError(null);
    try {
      await api.saveContext(targetAgent, filename, buffer, base);
      // Apply only if we are still in the very same mounted view that started
      // this save. A -> B, or A -> B -> A, both change the generation, so an
      // older buffer can never be written into a later view.
      if (genRef.current !== myGen) return;
      setEditing(false);
      onSaved?.(filename, buffer);
    } catch (err: any) {
      console.error('Failed to save:', err);
      // Only surface the failure if we are still on the view that saved, so a
      // stale save can't paint an error over an unrelated agent. The buffer is
      // left intact (we do NOT exit editing) so the user can retry or copy it.
      if (genRef.current === myGen) {
        const msg = String(err?.message ?? '');
        const conflict = /\b409\b/.test(msg) || /stale_write/i.test(msg);
        setSaveError(
          conflict
            ? 'This file changed since you opened it (a newer save landed first). Reload to get the latest, then reapply your edit — your text is kept here.'
            : 'Could not save. Check your connection and try again — your text is kept here.',
        );
      }
    } finally {
      // Clear the indicator only if THIS exact request still owns it; a newer
      // save (any agent, any generation) holds a different token.
      setActiveSaveToken((prev) => (prev === myToken ? null : prev));
    }
  };

  return (
    <div
      className="bg-gray-800 rounded-xl overflow-hidden"
      data-testid={`context-file-${filename}`}
    >
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
          {hint ? <p className="text-[11px] text-gray-500 mb-2">{hint}</p> : null}
          {error ? (
            <div
              className="flex items-center gap-2 text-xs text-amber-400"
              data-testid={`context-file-${filename}-error`}
            >
              <AlertTriangle size={14} />
              <span>Failed to load {filename}.</span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={(e: any) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                  className="flex items-center gap-1 bg-gray-700 text-gray-200 hover:bg-gray-600 px-2 py-0.5 rounded-md"
                >
                  <RotateCw size={12} /> Retry
                </button>
              ) : null}
            </div>
          ) : loading || typeof content !== 'string' ? (
            <div
              className="flex items-center gap-2 text-xs text-gray-500"
              data-testid={`context-file-${filename}-loading`}
            >
              <Loader2 size={14} className="animate-spin" /> Loading {filename}…
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <button
                  type="button"
                  onClick={(e: any) => {
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
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !agentId}
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
                )}
              </div>
              {saveError ? (
                <p
                  className="flex items-start gap-1.5 text-[11px] text-amber-400 mb-2"
                  role="alert"
                  data-testid={`context-file-${filename}-save-error`}
                >
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span>{saveError}</span>
                </p>
              ) : null}
              {editing ? (
                <textarea
                  value={editContent}
                  onChange={(e: any) => {
                    setEditContent(e.target.value);
                    if (saveError) setSaveError(null);
                  }}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 font-mono focus:outline-none focus:border-gray-600 resize-y min-h-[200px]"
                  rows={12}
                />
              ) : (
                <div className="prose prose-invert prose-sm max-w-none text-xs max-h-96 overflow-y-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {content || '*(empty)*'}
                  </ReactMarkdown>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
