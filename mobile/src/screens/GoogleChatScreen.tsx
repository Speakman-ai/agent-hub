import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { shouldFollowTail } from '../utils/followTail';
import { useHubChatSnapshot } from '../hooks/useHubChat';
import {
  applyNewest,
  applyOlder,
  EMPTY_HISTORY,
  fetchNewest,
  type ChatHistory,
} from '../utils/googleChatHistory';
import { colors } from '../theme/colors';
import WindowKeyboardAvoidingView from '../components/WindowKeyboardAvoidingView';
import {
  CHAT_SURFACE_SCOPES,
  hasChatReadScope,
  hasChatSendScope,
  isGoogleConnected,
} from '../utils/googleSurface';
import { chatSenderLabel, chatSpaceLabel, type ChatSpace } from '@shared/utils/googleChat';
import { chatConsentAccountId } from '@shared/utils/googleChatAccount';

/** Merges a fetched page into a list, keeping the first copy of each record. */
function mergeByKey<T>(base: T[], page: T[], key: (item: T) => string | null | undefined): T[] {
  const seen = new Set(base.map(key).filter(Boolean));
  return [...base, ...page.filter((item) => !seen.has(key(item)))];
}

/** How often an open conversation is re-read while the app is in front (web parity). */
export const MESSAGES_POLL_MS = 5_000;

const spaceKey = (s: ChatSpace) => s.id;
const pageTokenOf = (body: any): string | null =>
  typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;

/**
 * Google Chat inside the mobile Hub Chat tab. Lists the signed-in user's
 * spaces through the Hub proxy and opens a thread they can read and reply in.
 * Remounted per account, so nothing fetched or typed for one saved login
 * survives a switch to another.
 */
export default function GoogleChatPane() {
  const { account } = useHubChatSnapshot();
  return <AccountGoogleChatPane key={account} />;
}

function AccountGoogleChatPane() {
  const [status, setStatus] = useState<any>(null);
  const [spaces, setSpaces] = useState<ChatSpace[]>([]);
  const [spacesToken, setSpacesToken] = useState<string | null>(null);
  const [space, setSpace] = useState<ChatSpace | null>(null);
  const [history, setHistory] = useState<ChatHistory>(EMPTY_HISTORY);
  const messages = history.messages;
  const messagesToken = history.cursor;
  const [selfName, setSelfName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  // Messages whose send failed while a newer draft was in the composer. Kept
  // until the user retries, edits or discards them, so no text is lost.
  const [unsent, setUnsent] = useState<{ id: number; text: string }[]>([]);
  const unsentSeq = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [sending, setSending] = useState(false);

  // Responses land only while this pane is mounted and still showing what
  // they were requested for; each counter is bumped when its view changes.
  const alive = useRef(true);
  const spacesGen = useRef(0);
  const viewGen = useRef(0);
  const openSpaceId = useRef<string | null>(null);
  const listRef = useRef<FlatList<ChatHistory['messages'][number]> | null>(null);
  // Opening a conversation lands on its newest message and keeps following
  // until the reader scrolls up.
  const stickToBottomRef = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Status is probed from several places (thread foreground re-check, every
  // spaces load); only a reply to a newer probe than the last applied may land.
  const statusSeq = useRef(0);
  const statusApplied = useRef(0);
  const probeStatus = useCallback(async () => {
    const seq = ++statusSeq.current;
    const next = await api.getGoogleStatus();
    if (alive.current && seq > statusApplied.current) {
      statusApplied.current = seq;
      setStatus(next);
    }
    return next;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      await probeStatus();
    } catch {
      // Keep the last known status; the next foreground retries.
    }
  }, [probeStatus]);

  const loadSpaces = useCallback(
    async (pageToken?: string) => {
      const gen = pageToken ? spacesGen.current : ++spacesGen.current;
      const current = () => alive.current && gen === spacesGen.current;
      setError('');
      if (pageToken) setLoadingMore(true);
      try {
        if (!pageToken) {
          const next = await probeStatus();
          if (!current()) return;
          if (!isGoogleConnected(next) || !hasChatReadScope(next)) {
            setSpaces([]);
            setSpacesToken(null);
            return;
          }
        }
        const body = await api.listGoogleChatSpaces({ pageSize: 50, pageToken });
        if (!current()) return;
        const page: ChatSpace[] = Array.isArray(body?.spaces) ? body.spaces : [];
        setSpaces((prev) => (pageToken ? mergeByKey(prev, page, spaceKey) : page));
        setSpacesToken(pageTokenOf(body));
      } catch (err: any) {
        if (!current()) return;
        setError(err?.message || 'Failed to load Google Chat');
        if (!pageToken) setSpaces([]);
      } finally {
        if (current()) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [probeStatus],
  );

  // Message requests for the open conversation: the first load, refreshes
  // (poll, foreground, pull, after a send) and older pages. They can overlap,
  // so each response is checked against
  //  - the view: opening or leaving a conversation starts a new view, and a
  //    response from an earlier visit (even to the same space) is dropped;
  //  - its order: newest-first fetches carry an increasing seq and apply only
  //    if newer than the last that did; an older page applies only while the
  //    cursor it was fetched with is still the history's cursor.
  // The history itself (see googleChatHistory.ts) always stays one unbroken
  // run with its cursor, so nothing between newest and oldest goes missing.
  const headSeq = useRef(0);
  const headApplied = useRef(0);
  const olderSeq = useRef(0);
  const historyRef = useRef<ChatHistory>(EMPTY_HISTORY);
  historyRef.current = history;
  const [refreshing, setRefreshing] = useState(false);

  /** Catch up from the newest message. `initial` shows the spinner and errors. */
  const syncNewest = useCallback(
    async (open: ChatSpace, mode: 'initial' | 'refresh' | 'manual') => {
      if (!open.id) return;
      const spaceId = open.id;
      const view = viewGen.current;
      const seq = ++headSeq.current;
      const sameView = () => alive.current && view === viewGen.current;
      if (mode === 'initial') {
        setError('');
        setLoading(true);
      }
      if (mode === 'manual') setRefreshing(true);
      try {
        const result = await fetchNewest(
          (pageToken) =>
            api.listGoogleChatMessages(spaceId, {
              pageSize: 50,
              order: 'desc',
              ...(pageToken ? { pageToken } : {}),
            }),
          historyRef.current.messages,
        );
        if (!sameView() || seq <= headApplied.current) return;
        headApplied.current = seq;
        if (result.selfUserName) setSelfName(result.selfUserName);
        setHistory((prev) => applyNewest(prev, result));
      } catch (err: any) {
        if (sameView() && mode !== 'refresh') {
          setError(err?.message || 'Failed to load messages');
        }
      } finally {
        if (sameView()) {
          if (mode === 'initial') setLoading(false);
          if (mode === 'manual') setRefreshing(false);
        }
      }
    },
    [],
  );

  const loadOlder = useCallback(async (open: ChatSpace, cursor: string) => {
    if (!open.id) return;
    const view = viewGen.current;
    const seq = ++olderSeq.current;
    const current = () => alive.current && view === viewGen.current && seq === olderSeq.current;
    stickToBottomRef.current = false;
    setError('');
    setLoadingMore(true);
    try {
      const body = await api.listGoogleChatMessages(open.id, {
        pageSize: 50,
        order: 'desc',
        pageToken: cursor,
      });
      if (!current()) return;
      // Only below the run it was fetched for: a refresh that replaced the
      // run since has a different cursor, and this page would leave a hole.
      setHistory((prev) => (prev.cursor === cursor ? applyOlder(prev, body) : prev));
    } catch (err: any) {
      if (current()) setError(err?.message || 'Failed to load messages');
    } finally {
      if (current()) setLoadingMore(false);
    }
  }, []);

  const refreshMessages = useCallback(
    (open: ChatSpace, manual = false) => syncNewest(open, manual ? 'manual' : 'refresh'),
    [syncNewest],
  );

  const resetView = () => {
    viewGen.current++;
    stickToBottomRef.current = true;
    setHistory(EMPTY_HISTORY);
    setSelfName(null);
    setDraft('');
    setUnsent([]);
    setLoadingMore(false);
    setRefreshing(false);
  };

  const openSpace = (next: ChatSpace) => {
    resetView();
    openSpaceId.current = next.id || null;
    setSpace(next);
    void syncNewest(next, 'initial');
  };

  const closeSpace = () => {
    resetView();
    openSpaceId.current = null;
    setSpace(null);
    void loadSpaces();
  };

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  useEffect(() => {
    // Back in front (including from Google consent): re-probe the grant so a
    // newly enabled scope takes effect, and catch up on what arrived meanwhile.
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (space) {
        void refreshStatus();
        void refreshMessages(space);
      } else void loadSpaces();
    });
    return () => sub.remove();
  }, [loadSpaces, refreshMessages, refreshStatus, space]);

  useEffect(() => {
    if (!space?.id) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refreshMessages(space);
    }, MESSAGES_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshMessages, space]);

  const connect = async () => {
    try {
      const body = await api.startGoogleOAuth({
        returnTo: '/#/chat',
        scopes: CHAT_SURFACE_SCOPES,
        // Chat consent goes to the Chat account, not necessarily the default.
        accountId: chatConsentAccountId(status),
      });
      if (body?.authorizeUrl) await Linking.openURL(body.authorizeUrl);
    } catch (err: any) {
      Alert.alert('Google Chat', err?.message || 'Failed to start Google consent');
    }
  };

  /**
   * Send `text`. The composer is cleared on submit so the next message can be
   * typed while this one sends. On failure the text goes back into an empty
   * composer, or, if a newer draft is there, into the unsent list.
   */
  const sendText = async (text: string, fromComposer: boolean) => {
    const target = space;
    if (!text.trim() || !target?.id || sending) return false;
    const view = viewGen.current;
    const stillOpen = () => alive.current && view === viewGen.current;
    if (fromComposer) {
      // The ref too: a failure can land before the next render updates it.
      draftRef.current = '';
      setDraft('');
    }
    setSending(true);
    setError('');
    try {
      await api.sendGoogleChatMessage(target.id, { text: text.trim() });
      if (!stillOpen()) return true;
      stickToBottomRef.current = true;
      await syncNewest(target, 'refresh');
      return true;
    } catch (err: any) {
      if (!stillOpen()) return false;
      setError(err?.message || 'Failed to send');
      if (!draftRef.current) setDraft(text);
      else setUnsent((list) => [...list, { id: ++unsentSeq.current, text }]);
      return false;
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const send = () => sendText(draft, true);

  const retryUnsent = async (id: number) => {
    const item = unsent.find((u) => u.id === id);
    if (!item) return;
    setUnsent((list) => list.filter((u) => u.id !== id));
    await sendText(item.text, false);
  };

  const editUnsent = (id: number) => {
    const item = unsent.find((u) => u.id === id);
    if (!item) return;
    setUnsent((list) => list.filter((u) => u.id !== id));
    // Never overwrite what is being typed: append below it.
    setDraft((current) => (current ? `${current}\n${item.text}` : item.text));
  };

  const connected = isGoogleConnected(status);
  const canRead = hasChatReadScope(status);
  const canSend = hasChatSendScope(status);

  if (space) {
    return (
      <WindowKeyboardAvoidingView style={styles.root} testID="google-chat-thread">
        <View style={styles.threadHeader}>
          <TouchableOpacity
            onPress={closeSpace}
            accessibilityLabel="Back to conversations"
            testID="google-chat-back"
          >
            <Text style={styles.link}>Conversations</Text>
          </TouchableOpacity>
          <Text style={styles.threadTitle} numberOfLines={1}>
            {chatSpaceLabel(space)}
          </Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading ? (
          <ActivityIndicator color={colors.sky400} style={styles.spinner} />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item, index) => item.name || item.id || String(index)}
            contentContainerStyle={styles.listPad}
            // Prepending an older page keeps the reader's place.
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
            scrollEventThrottle={100}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              stickToBottomRef.current = shouldFollowTail(
                contentOffset.y,
                layoutMeasurement.height,
                contentSize.height,
              );
            }}
            onContentSizeChange={() => {
              if (stickToBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
            }}
            refreshing={refreshing}
            onRefresh={() => void refreshMessages(space, true)}
            ListHeaderComponent={
              messagesToken ? (
                <LoadMore
                  label="Load older messages"
                  busy={loadingMore}
                  onPress={() => void loadOlder(space, messagesToken)}
                  testID="google-chat-older"
                />
              ) : null
            }
            renderItem={({ item }) => {
              const mine = !!selfName && item.sender?.name === selfName;
              return (
                <View style={[styles.message, mine && styles.messageMine]}>
                  <Text style={styles.sender}>{mine ? 'You' : chatSenderLabel(item.sender)}</Text>
                  <Text style={styles.body}>
                    {item.deleted ? 'Message deleted' : item.text || ''}
                    {item.attachmentCount ? ` · ${item.attachmentCount} attachment` : ''}
                    {(item.attachmentCount || 0) > 1 ? 's' : ''}
                  </Text>
                </View>
              );
            }}
            ListEmptyComponent={<Text style={styles.muted}>No messages yet.</Text>}
          />
        )}
        {unsent.map((item) => (
          <View key={item.id} style={styles.unsent} testID={`google-chat-unsent-${item.id}`}>
            <Text style={styles.unsentText} numberOfLines={3}>
              Not sent: {item.text}
            </Text>
            <View style={styles.unsentActions}>
              <TouchableOpacity
                onPress={() => void retryUnsent(item.id)}
                disabled={sending || !canSend}
                testID={`google-chat-unsent-retry-${item.id}`}
              >
                <Text style={styles.link}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => editUnsent(item.id)}
                testID={`google-chat-unsent-edit-${item.id}`}
              >
                <Text style={styles.link}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setUnsent((list) => list.filter((u) => u.id !== item.id))}
                testID={`google-chat-unsent-discard-${item.id}`}
              >
                <Text style={styles.link}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        {canSend ? (
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message"
              placeholderTextColor={colors.gray600}
              testID="google-chat-input"
            />
            <TouchableOpacity
              onPress={() => void send()}
              disabled={!draft.trim() || sending}
              style={styles.send}
              testID="google-chat-send"
            >
              <Text style={styles.sendText}>Send</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={() => void connect()} style={styles.enable}>
            <Text style={styles.enableText}>Enable sending</Text>
          </TouchableOpacity>
        )}
      </WindowKeyboardAvoidingView>
    );
  }

  let gate: { title: string; action: string | null } | null = null;
  if (status && status.serverConfigured === false && !connected) {
    gate = { title: 'Google is not configured on this Hub.', action: null };
  } else if (status && !connected) {
    gate = { title: 'Connect Google to use Chat.', action: 'Connect Google' };
  } else if (status && !canRead) {
    gate = {
      title: `Connected as ${status.email || 'your Google account'}, but Chat access has not been granted yet.`,
      action: 'Enable Chat',
    };
  }

  return (
    <View style={styles.root} testID="google-chat-pane">
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && !status ? (
        <ActivityIndicator color={colors.sky400} style={styles.spinner} />
      ) : gate ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{gate.title}</Text>
          {gate.action ? (
            <TouchableOpacity
              onPress={() => void connect()}
              style={styles.enable}
              testID="google-chat-connect"
            >
              <Text style={styles.enableText}>{gate.action}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={spaces}
          keyExtractor={(item, index) => item.id || String(index)}
          contentContainerStyle={styles.listPad}
          refreshing={loading}
          onRefresh={() => {
            setLoading(true);
            void loadSpaces();
          }}
          onEndReached={() => {
            if (spacesToken && !loadingMore) void loadSpaces(spacesToken);
          }}
          ListFooterComponent={
            spacesToken ? (
              <LoadMore
                label="More conversations"
                busy={loadingMore}
                onPress={() => void loadSpaces(spacesToken)}
                testID="google-chat-more-spaces"
              />
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.space}
              onPress={() => openSpace(item)}
              testID={`google-chat-space-${item.id}`}
            >
              <Text style={styles.spaceName}>{chatSpaceLabel(item)}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.muted}>No conversations yet. Pull to refresh.</Text>
          }
        />
      )}
    </View>
  );
}

function LoadMore({
  label,
  busy,
  onPress,
  testID,
}: {
  label: string;
  busy: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} disabled={busy} style={styles.more} testID={testID}>
      {busy ? (
        <ActivityIndicator color={colors.sky400} />
      ) : (
        <Text style={styles.link}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.gray950 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  spinner: { marginTop: 24 },
  muted: { color: colors.gray400, fontSize: 13, textAlign: 'center' },
  error: { color: colors.red400, fontSize: 12, paddingHorizontal: 12, paddingTop: 8 },
  listPad: { padding: 12, gap: 8 },
  space: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  spaceName: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  link: { color: colors.sky300, fontSize: 13 },
  more: { alignItems: 'center', paddingVertical: 10 },
  threadTitle: { flex: 1, color: colors.gray100, fontSize: 15, fontWeight: '600' },
  message: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    marginBottom: 8,
  },
  messageMine: { backgroundColor: colors.gray800 },
  sender: { color: colors.gray400, fontSize: 11, marginBottom: 2 },
  body: { color: colors.gray100, fontSize: 14 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  input: {
    flex: 1,
    color: colors.gray100,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.gray900,
  },
  send: {
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sendText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  enable: {
    alignSelf: 'center',
    margin: 12,
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  enableText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  unsent: {
    marginHorizontal: 10,
    marginTop: 6,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.red400,
    gap: 6,
  },
  unsentText: { color: colors.gray200, fontSize: 13 },
  unsentActions: { flexDirection: 'row', gap: 16 },
});
