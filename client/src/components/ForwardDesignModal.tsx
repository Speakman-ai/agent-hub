import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, X, ArrowLeftRight } from 'lucide-react';

/**
 * Agents eligible to receive a forwarded design. Prefer agents in linked
 * projects when the design has links; if none match, fall back to all
 * active agents so forwarding still works.
 */
export function filterDesignForwardTargets(agents: any, design: any) {
  if (!Array.isArray(agents) || !design) return [];
  const base = agents.filter((a: any) => a && a.active !== false);
  const linkedIds = (design.linkedProjects || []).map((p: any) => p?.id).filter(Boolean);
  if (linkedIds.length === 0) return base;
  const linkedSet = new Set(linkedIds);
  const inLinked = base.filter((a: any) => linkedSet.has(a.projectId));
  return inLinked.length > 0 ? inLinked : base;
}

export default function ForwardDesignModal({
  design,
  agents,
  onClose,
  onForwarded,
  onForward,
  onError,
}: any) {
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);
  const [prompt, setPrompt] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [includeMessages, setIncludeMessages] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);
  const [query, setQuery] = useState('');
  const inputRef = useRef<any>(null);

  const candidates = useMemo(() => filterDesignForwardTargets(agents, design), [agents, design]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((a: any) => (a.name || '').toLowerCase().includes(q));
  }, [candidates, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, submitting]);

  const handleSubmit = async (e: any) => {
    e?.preventDefault?.();
    if (!selectedAgentId || submitting || !design?.id) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onForward({
        targetAgentId: selectedAgentId,
        prompt: prompt.trim() || undefined,
        autoStart,
        includeMessages,
        includeFiles,
      });
      if (typeof onForwarded === 'function') onForwarded(result);
      onClose();
    } catch (err: any) {
      const message = err?.message || 'Forward failed';
      setError(message);
      if (typeof onError === 'function') onError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const hasCandidates = candidates.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/60"
      onClick={() => (submitting ? null : onClose())}
      data-testid="forward-design-modal-backdrop"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e: any) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowLeftRight size={16} className="text-gray-400 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-100 flex-shrink-0">Forward design</h3>
            {design?.name && (
              <span className="text-xs text-gray-500 truncate" title={design.name}>
                {design.name}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-gray-500 hover:text-gray-200 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {!hasCandidates ? (
          <div className="p-6 text-sm text-gray-400">
            No active agents available. Add an agent in Settings to forward this design into a chat
            session.
          </div>
        ) : (
          <>
            <div className="px-4 pt-3">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e: any) => setQuery(e.target.value)}
                placeholder="Filter agents..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[80px]">
              {filtered.length === 0 && (
                <p className="text-sm text-gray-500 px-4 py-3">No agents match.</p>
              )}
              {filtered.map((agent: any) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-3 rounded-lg transition-colors ${
                    selectedAgentId === agent.id
                      ? 'bg-gray-800 border border-gray-600'
                      : 'border border-transparent hover:bg-gray-800/60'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: agent.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-200 truncate">{agent.name}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {agent.engine}
                      {agent.projectName ? ` · ${agent.projectName}` : ''}
                    </div>
                  </div>
                  {selectedAgentId === agent.id && (
                    <span className="text-xs text-emerald-400">✓</span>
                  )}
                </button>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-gray-800 space-y-3">
              <div>
                <label
                  htmlFor="forward-design-prompt"
                  className="block text-xs font-medium text-gray-400 mb-1"
                >
                  Extra instructions (optional)
                </label>
                <textarea
                  id="forward-design-prompt"
                  value={prompt}
                  onChange={(e: any) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="What should the target agent do with this design?"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600 resize-y"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeMessages}
                  onChange={(e: any) => setIncludeMessages(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-800"
                />
                Include design chat transcript
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeFiles}
                  onChange={(e: any) => setIncludeFiles(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-800"
                />
                Include design file contents (HTML/CSS/JS)
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e: any) => setAutoStart(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-800"
                />
                Auto-start target agent
              </label>
              {error && (
                <p className="text-xs text-red-400" role="alert">
                  {error}
                </p>
              )}
            </div>
          </>
        )}

        <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-xs px-3 py-2 rounded-lg text-gray-400 hover:text-gray-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!selectedAgentId || submitting || !hasCandidates || !design?.id}
            className="text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {submitting ? 'Forwarding...' : 'Forward'}
          </button>
        </div>
      </form>
    </div>
  );
}
