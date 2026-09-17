import { useEffect, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { formatAutopilotPrCommittedLabel } from '@shared/utils/sessionAutopilot';
import { api } from '../../utils/api';
import { SESSION_ACTION_TOOLBAR_BUTTON_CLASS } from '../../utils/sessionActionMenu';

function readPushedCount(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export default function AutopilotPrCounter({
  sessionId,
  count = 0,
}: {
  sessionId: string;
  count?: number;
}) {
  const [liveCount, setLiveCount] = useState(() => readPushedCount(count) ?? 0);

  useEffect(() => {
    setLiveCount(readPushedCount(count) ?? 0);
  }, [sessionId, count]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    const refresh = () => {
      api
        .getSessionDetail(sessionId)
        .then((session: { finalize_pushed_count?: unknown }) => {
          if (cancelled) return;
          const next = readPushedCount(session?.finalize_pushed_count);
          if (next != null) setLiveCount(next);
        })
        .catch(() => {
          /* keep the last known count */
        });
    };
    const onCompleted = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.session_id !== sessionId) return;
      if (detail.status !== 'pushed') return;
      refresh();
    };
    window.addEventListener('finalize_run_completed', onCompleted);
    window.addEventListener('agenthub:ws_reconnected', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('finalize_run_completed', onCompleted);
      window.removeEventListener('agenthub:ws_reconnected', refresh);
    };
  }, [sessionId]);

  const label = formatAutopilotPrCommittedLabel(liveCount);
  return (
    <div
      data-testid="autopilot-pr-counter"
      title={label}
      className={`${SESSION_ACTION_TOOLBAR_BUTTON_CLASS} border-emerald-700/60 bg-emerald-950/40 text-emerald-100 cursor-default`}
    >
      <GitPullRequest size={14} className="shrink-0" aria-hidden />
      <span className="font-medium">{label}</span>
    </div>
  );
}
