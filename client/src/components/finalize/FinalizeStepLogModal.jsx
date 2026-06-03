import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { api } from '../../utils/api.js';

export default function FinalizeStepLogModal({
  open,
  projectId,
  runId,
  stepIndex,
  stepName,
  stepState,
  onClose,
}) {
  const [lines, setLines] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  const load = useCallback(() => {
    if (!open || !projectId || !runId || !stepIndex) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    api
      .getFinalizeStepOutput(projectId, runId, stepIndex, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setLines(Array.isArray(data?.lines) ? data.lines : []);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoadError(err?.message || 'Failed to load step output');
        setLines([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, projectId, runId, stepIndex]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, lines, loading]);

  if (!open) return null;

  const title = stepName ? `${stepName} logs` : `Step ${stepIndex} logs`;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finalize-step-log-title"
      data-testid="finalize-step-log-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[min(80vh,40rem)] rounded-xl border border-gray-700 bg-gray-950 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800">
          <div className="min-w-0">
            <h2
              id="finalize-step-log-title"
              className="text-sm font-semibold text-gray-100 truncate"
            >
              {title}
            </h2>
            {stepState ? (
              <p className="text-[11px] text-gray-500 capitalize">{stepState.replace(/_/g, ' ')}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 p-1 rounded"
            aria-label="Close log viewer"
          >
            <X size={16} />
          </button>
        </header>
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[11px] leading-relaxed bg-gray-950/80"
          data-testid="finalize-step-log-body"
        >
          {loading ? (
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              Loading output…
            </div>
          ) : loadError ? (
            <p className="text-amber-300">{loadError}</p>
          ) : lines.length === 0 ? (
            <p className="text-gray-500">No output captured for this step yet.</p>
          ) : (
            lines.map((line, i) => (
              <div
                key={`${line.created_at}-${i}`}
                className={line.stream === 'stderr' ? 'text-red-300/90' : 'text-gray-300'}
              >
                {line.text}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
