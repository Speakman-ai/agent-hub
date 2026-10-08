import GoogleChatDraftCard from './GoogleChatDraftCard';
import { useChatDrafts } from '../utils/googleChatDrafts';

/** Shown when the draft list could not be refreshed; the last good list stays visible. */
export function DraftsLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div
      className="flex items-center gap-2 text-xs text-amber-300"
      data-testid="chat-drafts-load-error"
    >
      Could not refresh agent reply drafts: {error}. Retrying.
      <button type="button" onClick={onRetry} className="underline hover:text-amber-100">
        Retry now
      </button>
    </div>
  );
}

/**
 * Chat replies this session's agent wrote, held until the session owner
 * approves them. Renders nothing when there are none.
 */
export default function GoogleChatDraftsPanel({ sessionId }: { sessionId: string }) {
  const { drafts, error, reload, applyLocal } = useChatDrafts({ sessionId });
  // Most sessions never have drafts, so a failed load only shows here when
  // there are drafts on screen; it keeps retrying in the background either way.
  if (!drafts.length) return null;
  return (
    <div className="space-y-2" data-testid="session-chat-drafts">
      {error && <DraftsLoadError error={error} onRetry={reload} />}
      {drafts.map((draft) => (
        <GoogleChatDraftCard
          key={draft.id}
          draft={draft}
          context={`Google Chat ${draft.threadName ? 'thread reply' : 'message'} in ${draft.spaceId}`}
          onChanged={(updated) => (updated ? applyLocal(updated) : reload())}
        />
      ))}
    </div>
  );
}
