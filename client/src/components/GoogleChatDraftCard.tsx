import { useState } from 'react';
import { AlertCircle, Check, Loader2, Pencil, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import type { ChatDraft } from '../utils/googleChatDrafts';

type Busy = null | 'approve' | 'save' | 'discard';

/**
 * One agent-written Chat reply waiting for the owner. Approve posts it under
 * the owner's Google identity; Edit changes the text first; Discard drops it.
 */
export default function GoogleChatDraftCard({
  draft,
  context,
  onChanged,
}: {
  draft: ChatDraft;
  /** Where the reply goes, e.g. "Reply in thread" or "Acme support". */
  context?: string | null;
  /** Called with the server's copy after any action, or null to force a reload. */
  onChanged?: (draft: ChatDraft | null) => void;
}) {
  const [editingRaw, setEditing] = useState(false);
  // An unconfirmed send may already have posted, so its text is frozen and the
  // only actions are an identical retry or a discard.
  const unconfirmed = draft.status === 'unconfirmed';
  const editing = editingRaw && draft.status === 'pending';
  // The revision the user started editing from. Saving or sending the edit
  // names it, so a change made elsewhere meanwhile is refused, not overwritten.
  const [editBase, setEditBase] = useState(draft.revision);
  const reviewed = editing ? editBase : draft.revision;
  // The draft changed elsewhere after this edit began. Actions with the old
  // revision would be refused, so they are disabled until the user reviews
  // the current text: drop the edit, or keep it on top of the current version.
  const stale = editing && draft.revision !== editBase;
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = draft.status === 'sending' || busy === 'approve';
  const blocked = !!busy || sending || stale;

  const run = async (kind: Exclude<Busy, null>, call: () => Promise<any>) => {
    setBusy(kind);
    setError(null);
    try {
      const body = await call();
      if (kind === 'save') setEditing(false);
      onChanged?.(body?.draft ?? null);
    } catch (err: any) {
      setError(err?.message || 'Request failed');
      onChanged?.(null);
    } finally {
      setBusy(null);
    }
  };

  const trimmed = text.trim();
  const shownError = error || draft.error;

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-sm"
      data-testid={`chat-draft-${draft.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-amber-200/90">
        <span className="font-medium">
          {unconfirmed ? 'Agent reply: send not confirmed' : 'Agent reply awaiting your approval'}
          {context ? ` · ${context}` : ''}
        </span>
        {sending && (
          <span className="inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> Sending
          </span>
        )}
      </div>
      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          aria-label="Edit draft reply"
          className="mt-2 w-full resize-y rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-500"
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-words text-gray-200">{draft.text}</p>
      )}
      {stale && (
        <div
          className="mt-2 rounded border border-amber-500/40 p-2 text-xs text-amber-200"
          data-testid="chat-draft-stale"
        >
          <div>This draft changed elsewhere while you were editing. Current text:</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-gray-200">{draft.text}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setText(draft.text);
                setError(null);
              }}
              className="rounded border border-gray-700 px-2 py-1 text-gray-200 hover:bg-gray-800"
            >
              Use current version
            </button>
            <button
              type="button"
              onClick={() => {
                setEditBase(draft.revision);
                setError(null);
              }}
              className="rounded border border-gray-700 px-2 py-1 text-gray-200 hover:bg-gray-800"
            >
              Keep my edit
            </button>
          </div>
        </div>
      )}
      {shownError && (
        <div className="mt-2 flex items-start gap-1 text-xs text-red-300">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          {shownError}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={blocked || !trimmed}
          onClick={() =>
            run('approve', () =>
              api.approveGoogleChatDraft(draft.id, reviewed, editing ? trimmed : undefined),
            )
          }
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy === 'approve' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Check size={12} />
          )}
          {unconfirmed ? 'Retry send' : editing ? 'Save and send' : 'Approve and send'}
        </button>
        {editing ? (
          <>
            <button
              type="button"
              disabled={blocked || !trimmed || trimmed === draft.text}
              onClick={() =>
                run('save', () => api.editGoogleChatDraft(draft.id, editBase, trimmed))
              }
              className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            >
              Save draft
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                setEditing(false);
                setText(draft.text);
              }}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </>
        ) : unconfirmed ? null : (
          <button
            type="button"
            disabled={!!busy || sending}
            onClick={() => {
              setText(draft.text);
              setEditBase(draft.revision);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
          >
            <Pencil size={12} />
            Edit
          </button>
        )}
        <button
          type="button"
          disabled={blocked}
          onClick={() => run('discard', () => api.discardGoogleChatDraft(draft.id, reviewed))}
          className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
        >
          <Trash2 size={12} />
          Discard
        </button>
      </div>
    </div>
  );
}
