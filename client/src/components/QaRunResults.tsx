import { useEffect, useState } from 'react';
import { ImageIcon, X } from 'lucide-react';
import { artifactRenderKind } from '@shared/utils/artifactView';
import type { QaCaseWire, QaResultWire, QaRunWire, QaScreenshotWire } from '../utils/api';
import { fetchArtifactBlob } from '../utils/artifactContent';
import { VERDICT_CLASS, VERDICT_LABELS } from '../utils/qaLabels';
import SessionArtifactViewer from './SessionArtifactViewer';

/**
 * A run's results in case order. Results for cases no longer on the plan
 * (deleted since the run) follow, titled by id, so evidence never disappears.
 */
export function orderRunResults(
  results: QaResultWire[],
  cases: Pick<QaCaseWire, 'id' | 'title' | 'expected' | 'version'>[],
): Array<{
  result: QaResultWire;
  qaCase: Pick<QaCaseWire, 'id' | 'title' | 'expected' | 'version'> | null;
}> {
  const byCase = new Map(results.map((r) => [r.caseId, r]));
  const ordered = cases
    .filter((c) => byCase.has(c.id))
    .map((c) => ({ result: byCase.get(c.id)!, qaCase: c }));
  const known = new Set(cases.map((c) => c.id));
  const orphans = results
    .filter((r) => !known.has(r.caseId))
    .map((result) => ({ result, qaCase: null }));
  return [...ordered, ...orphans];
}

function ScreenshotThumb({
  sessionId,
  shot,
  onOpen,
}: {
  sessionId: string;
  shot: QaScreenshotWire;
  onOpen: () => void;
}) {
  const isImage = artifactRenderKind(shot.contentType, shot.filename) === 'image';
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return undefined;
    let disposed = false;
    let objectUrl = '';
    fetchArtifactBlob(sessionId, shot.id)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* the filename tile stays; the viewer reports the error on open */
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, sessionId, shot.id]);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={shot.filename}
      data-testid={`qa-screenshot-${shot.id}`}
      className="flex h-20 w-28 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-gray-700 bg-gray-900 hover:border-blue-500"
    >
      {url ? (
        <img src={url} alt={shot.filename} className="h-full w-full object-cover" />
      ) : (
        <span className="flex flex-col items-center gap-1 px-1 text-[10px] text-gray-400">
          <ImageIcon size={14} />
          <span className="max-w-full truncate">{shot.filename}</span>
        </span>
      )}
    </button>
  );
}

/** Full-size view of one screenshot through the run session's artifact viewer. */
function ScreenshotViewer({
  sessionId,
  shot,
  onClose,
}: {
  sessionId: string;
  shot: QaScreenshotWire;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label={shot.filename}
      data-testid="qa-screenshot-viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
          <span className="truncate text-sm text-gray-200">{shot.filename}</span>
          <button
            type="button"
            aria-label="Close"
            data-testid="qa-screenshot-viewer-close"
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <SessionArtifactViewer
            sessionId={sessionId}
            artifact={{ id: shot.id, filename: shot.filename, contentType: shot.contentType }}
          />
        </div>
      </div>
    </div>
  );
}

export function QaScreenshotGallery({
  sessionId,
  screenshots,
}: {
  sessionId: string | null;
  screenshots: QaScreenshotWire[];
}) {
  const [open, setOpen] = useState<QaScreenshotWire | null>(null);
  if (!sessionId || screenshots.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2" data-testid="qa-screenshot-gallery">
        {screenshots.map((shot) => (
          <ScreenshotThumb
            key={shot.id}
            sessionId={sessionId}
            shot={shot}
            onOpen={() => setOpen(shot)}
          />
        ))}
      </div>
      {open && <ScreenshotViewer sessionId={sessionId} shot={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="whitespace-pre-wrap break-words text-xs text-gray-300">
        {text.trim() || <span className="text-gray-600">None recorded</span>}
      </div>
    </div>
  );
}

export default function QaRunResults({
  run,
  cases,
  onOpenCard,
}: {
  run: Pick<QaRunWire, 'id' | 'sessionId' | 'results'>;
  cases: Pick<QaCaseWire, 'id' | 'title' | 'expected' | 'version'>[];
  onOpenCard?: (cardId: string) => void;
}) {
  const rows = orderRunResults(run.results ?? [], cases);
  if (rows.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-gray-500" data-testid="qa-run-results-empty">
        No results recorded yet.
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-gray-800" data-testid={`qa-run-results-${run.id}`}>
      {rows.map(({ result, qaCase }) => (
        <li
          key={result.id}
          className="flex flex-col gap-2 px-3 py-2"
          data-testid={`qa-result-${result.caseId}`}
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-100">
              {qaCase?.title ?? `Deleted case ${result.caseId}`}
            </span>
            <span
              className={`text-xs ${VERDICT_CLASS[result.verdict]}`}
              data-testid="qa-result-verdict"
            >
              {VERDICT_LABELS[result.verdict]}
            </span>
            {qaCase && result.caseVersion !== qaCase.version && (
              <span className="text-[11px] text-gray-500">
                recorded against v{result.caseVersion}
              </span>
            )}
            {result.findingCardId && (
              <button
                type="button"
                data-testid="qa-result-finding"
                disabled={!onOpenCard}
                onClick={() => onOpenCard?.(result.findingCardId!)}
                className="ml-auto rounded-full border border-red-900 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-950 disabled:opacity-60"
              >
                Finding card
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Field label="Expected" text={qaCase?.expected ?? ''} />
            <Field label="Actual" text={result.actual} />
          </div>
          {result.notes.trim() && <Field label="Notes" text={result.notes} />}
          <QaScreenshotGallery sessionId={run.sessionId} screenshots={result.screenshots} />
        </li>
      ))}
    </ul>
  );
}
