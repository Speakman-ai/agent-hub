/**
 * SessionChatDraftsPanel — mobile parity for the web GoogleChatDraftsPanel.
 *
 * Google Chat replies this session's agent wrote go out under the session
 * owner's Google identity, so the server holds them as drafts. This panel
 * lists them above the chat with Approve / Edit / Discard, and renders
 * nothing when there are none. Live updates arrive through
 * `lastGoogleChatDraftEvent` (AppContext's bridge for the owner-only
 * `google_chat_draft_update` WS event).
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { useApp } from '../context/AppContext';
import type { ChatDraft } from '@shared/utils/googleChatDrafts';
import { DraftListController, EMPTY_DRAFT_SNAPSHOT } from '@shared/utils/googleChatDraftList';

type Busy = null | 'approve' | 'save' | 'discard';

export function DraftCard({
  draft,
  onChanged,
}: {
  draft: ChatDraft;
  onChanged: (draft: ChatDraft | null) => void;
}) {
  const [editingRaw, setEditing] = useState(false);
  // An unconfirmed send may already have posted: its text is frozen and the
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
  const trimmed = text.trim();

  const run = async (kind: Exclude<Busy, null>, call: () => Promise<any>) => {
    setBusy(kind);
    setError(null);
    try {
      const body = await call();
      if (kind === 'save') setEditing(false);
      onChanged(body?.draft ?? null);
    } catch (err: any) {
      setError(err?.message || 'Request failed');
      onChanged(null);
    } finally {
      setBusy(null);
    }
  };

  const shownError = error || draft.error;
  return (
    <View style={styles.card} testID={`chat-draft-${draft.id}`}>
      <Text style={styles.title}>
        {unconfirmed
          ? 'Google Chat reply: send not confirmed'
          : 'Google Chat reply awaiting your approval'}
        {draft.threadName ? ' · thread reply' : ''}
      </Text>
      {editing ? (
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          accessibilityLabel="Edit draft reply"
          style={styles.input}
        />
      ) : (
        <Text style={styles.body}>{draft.text}</Text>
      )}
      {stale ? (
        <View style={styles.stale} testID="chat-draft-stale">
          <Text style={styles.staleTitle}>
            This draft changed elsewhere while you were editing. Current text:
          </Text>
          <Text style={styles.body}>{draft.text}</Text>
          <View style={styles.row}>
            <TouchableOpacity
              onPress={() => {
                setEditing(false);
                setText(draft.text);
                setError(null);
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>Use current version</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setEditBase(draft.revision);
                setError(null);
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>Keep my edit</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
      <View style={styles.row}>
        <TouchableOpacity
          disabled={blocked || !trimmed}
          onPress={() =>
            run('approve', () =>
              api.approveGoogleChatDraft(draft.id, reviewed, editing ? trimmed : undefined),
            )
          }
          style={[styles.primary, blocked && styles.disabled]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.primaryLabel}>
              {unconfirmed ? 'Retry send' : editing ? 'Save and send' : 'Approve and send'}
            </Text>
          )}
        </TouchableOpacity>
        {editing ? (
          <>
            <TouchableOpacity
              disabled={blocked || !trimmed || trimmed === draft.text}
              onPress={() =>
                run('save', () => api.editGoogleChatDraft(draft.id, editBase, trimmed))
              }
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>Save draft</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!!busy}
              onPress={() => {
                setEditing(false);
                setText(draft.text);
                setError(null);
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : unconfirmed ? null : (
          <TouchableOpacity
            disabled={!!busy || sending}
            onPress={() => {
              setText(draft.text);
              setEditBase(draft.revision);
              setEditing(true);
            }}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>Edit</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          disabled={blocked}
          onPress={() => run('discard', () => api.discardGoogleChatDraft(draft.id, reviewed))}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>Discard</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function SessionChatDraftsPanel({ sessionId }: { sessionId: string }) {
  const { lastGoogleChatDraftEvent, connected } = useApp() as any;
  // One controller per session, disposed when the session changes, so a late
  // load or a card's action result from the previous session is a no-op. Sync
  // rules (newest load wins, in-flight replay, keep-on-failure with backoff,
  // sending re-reads) live in shared/utils/googleChatDraftList.ts.
  const [owned, setOwned] = useState<{ key: string; c: DraftListController } | null>(null);
  const controller = owned && owned.key === sessionId ? owned.c : null;

  useEffect(() => {
    const c = new DraftListController({ sessionId }, { fetch: (f) => api.listGoogleChatDrafts(f) });
    setOwned({ key: sessionId, c });
    c.reload();
    return () => c.dispose();
  }, [sessionId]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => {}),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller?.getSnapshot() ?? EMPTY_DRAFT_SNAPSHOT,
    [controller],
  );
  const { drafts, error } = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    controller?.apply(lastGoogleChatDraftEvent?.draft);
  }, [lastGoogleChatDraftEvent, controller]);

  // Events sent while the socket was down are lost; re-read on reconnect.
  const wasConnected = useRef<boolean | undefined>(connected);
  useEffect(() => {
    if (connected && wasConnected.current === false) controller?.reload();
    wasConnected.current = connected;
  }, [connected, controller]);

  if (!drafts.length || !controller) return null;
  return (
    <View style={styles.panel}>
      {error ? (
        <View style={styles.row}>
          <Text style={styles.error}>Could not refresh drafts: {error}. Retrying.</Text>
          <TouchableOpacity onPress={controller.reload} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>Retry now</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {drafts.map((d) => (
        <DraftCard
          key={d.id}
          draft={d}
          onChanged={(updated) => (updated ? controller.apply(updated) : controller.reload())}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
    borderRadius: 8,
    padding: 10,
  },
  title: { color: colors.amber400, fontSize: 12, fontWeight: '600' },
  body: { color: colors.gray200, fontSize: 14, marginTop: 6 },
  input: {
    marginTop: 6,
    minHeight: 60,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    color: colors.white,
    borderRadius: 6,
    padding: 8,
    fontSize: 14,
  },
  error: { color: colors.red400, fontSize: 12, marginTop: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  primary: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 120,
    alignItems: 'center',
  },
  primaryLabel: { color: colors.white, fontSize: 12, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  secondaryLabel: { color: colors.gray200, fontSize: 12 },
  disabled: { opacity: 0.5 },
  stale: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.amber400,
    borderRadius: 6,
    padding: 8,
  },
  staleTitle: { color: colors.amber400, fontSize: 12 },
});
