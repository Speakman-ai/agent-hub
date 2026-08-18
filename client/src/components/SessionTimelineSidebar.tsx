import { useMemo, useState } from 'react';
import { History, FileDiff, FlaskConical, MessageSquareWarning, X } from 'lucide-react';
import {
  deriveSessionTimelineMarkers,
  type SessionTimelineKind,
  type SessionTimelineMarker,
  type SessionTimelineStatus,
} from '@shared/utils/sessionTimeline';
import { relativeTime } from '../utils/time';

function collapsedStorageKey(sessionId: string | null | undefined) {
  return sessionId ? `timelinePaneOpen:${sessionId}` : null;
}

export function readTimelinePaneOpen(sessionId: string | null | undefined): boolean {
  const key = collapsedStorageKey(sessionId);
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function writeTimelinePaneOpen(sessionId: string | null | undefined, open: boolean) {
  const key = collapsedStorageKey(sessionId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, open ? 'true' : 'false');
  } catch {
    /* storage unavailable */
  }
}

const KIND_META: Record<
  SessionTimelineKind,
  { label: string; Icon: typeof FileDiff; dot: string }
> = {
  change_summary: {
    label: 'Change summary',
    Icon: FileDiff,
    dot: 'bg-sky-400',
  },
  test_run: {
    label: 'Checks',
    Icon: FlaskConical,
    dot: 'bg-emerald-400',
  },
  review_comment: {
    label: 'Review comment',
    Icon: MessageSquareWarning,
    dot: 'bg-amber-400',
  },
};

function statusClass(status: SessionTimelineStatus, kind: SessionTimelineKind): string {
  if (status === 'fail') return 'bg-red-400';
  if (status === 'ok' && kind === 'test_run') return 'bg-emerald-400';
  if (status === 'pending') return 'bg-amber-300 animate-pulse';
  return KIND_META[kind].dot;
}

function kindLabel(kind: SessionTimelineKind): string {
  switch (kind) {
    case 'change_summary':
      return KIND_META.change_summary.label;
    case 'test_run':
      return KIND_META.test_run.label;
    case 'review_comment':
      return KIND_META.review_comment.label;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Toggleable session activity timeline. Markers jump to the matching
 * change summary, finalize checks round, or review comment in the chat.
 */
export default function SessionTimelineSidebar({
  sessionId,
  messages,
  selectedAnchorId = null,
  onSelectAnchor,
  onClose,
}: {
  sessionId?: string | null;
  messages?: any[] | null;
  selectedAnchorId?: string | null;
  onSelectAnchor?: (anchorId: string, messageId: string) => void;
  onClose?: () => void;
}) {
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const selected = selectedAnchorId ?? internalSelected;

  const markers = useMemo(() => deriveSessionTimelineMarkers({ messages }), [messages]);

  const handleSelect = (marker: SessionTimelineMarker) => {
    setInternalSelected(marker.anchorId);
    onSelectAnchor?.(marker.anchorId, marker.messageId);
  };

  return (
    <aside
      data-testid="session-timeline-sidebar"
      aria-label="Session timeline"
      className="flex flex-col min-h-0 shrink-0 w-[16.5rem] border-r border-gray-800/80 bg-gray-950 z-20 max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-2xl"
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-800/80 shrink-0">
        <History size={14} className="text-gray-400 shrink-0" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-300 flex-1">
          Timeline
        </h2>
        {markers.length > 0 ? (
          <span
            data-testid="session-timeline-count"
            className="text-[10px] tabular-nums text-gray-500"
          >
            {markers.length}
          </span>
        ) : null}
        {onClose ? (
          <button
            type="button"
            data-testid="session-timeline-close"
            onClick={onClose}
            className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800"
            aria-label="Hide timeline"
          >
            <X size={14} />
          </button>
        ) : null}
      </header>

      <ol className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-0">
        {markers.length === 0 ? (
          <li className="px-2 py-6 text-center text-[11px] text-gray-500 leading-relaxed">
            Markers appear here for each turn&apos;s change summary, finalize checks, and review
            comment.
          </li>
        ) : (
          markers.map((marker, index) => {
            const { Icon } = KIND_META[marker.kind];
            const isSelected = selected === marker.anchorId;
            const isLast = index === markers.length - 1;
            return (
              <li key={marker.id} className="relative flex gap-2">
                <div className="flex flex-col items-center w-4 shrink-0 pt-1.5">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${statusClass(marker.status, marker.kind)}`}
                    aria-hidden
                  />
                  {!isLast ? <span className="flex-1 w-px bg-gray-800 mt-1" aria-hidden /> : null}
                </div>
                <button
                  type="button"
                  data-testid="session-timeline-marker"
                  data-timeline-kind={marker.kind}
                  data-timeline-anchor-target={marker.anchorId}
                  onClick={() => handleSelect(marker)}
                  className={`flex-1 min-w-0 text-left rounded-lg px-2 py-1.5 mb-1 transition-colors ${
                    isSelected ? 'bg-gray-800/80 ring-1 ring-gray-600/60' : 'hover:bg-gray-900/70'
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500">
                    <Icon size={11} className="shrink-0" aria-hidden />
                    <span>{kindLabel(marker.kind)}</span>
                    {marker.createdAt ? (
                      <span className="ml-auto tabular-nums font-normal normal-case tracking-normal">
                        {relativeTime(marker.createdAt)}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-gray-200 mt-0.5 line-clamp-2">{marker.title}</p>
                  {marker.subtitle ? (
                    <p className="text-[10px] text-gray-500 mt-0.5 truncate">{marker.subtitle}</p>
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ol>
    </aside>
  );
}
