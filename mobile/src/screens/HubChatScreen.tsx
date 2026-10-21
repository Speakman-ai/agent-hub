import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  agentChannelAgentOptions,
  agentChannelStatus,
  authorLabel,
  channelLabel,
  isChannelMuted,
  layoutHubChatMessages,
  muteUntilIso,
  MUTE_PRESETS,
  RAIL_SECTIONS,
  railUnread,
  sectionChannels,
  HUB_CHAT_QUICK_REACTIONS,
  reactedByViewer,
  type HubChatChannel,
  type HubChatMessage,
  type HubChatMessageMeta,
  type HubChatNotifyLevel,
  type HubChatOrgMember,
  mentionPendingText,
  parseMentionNotices,
  type HubChatMentionNotice,
} from '@shared/utils/hubChat';
import {
  decodeToComposer,
  encodeComposerMentions,
  type ComposerMention,
  type HubChatResolvedRef,
} from '@shared/utils/hubChatRefs';
import { formatHubChatRefToken } from '@shared/utils/hubChatRefTokens';
import { isHubSystemProject } from '@shared/utils/hub';
import { useIsFocused } from '@react-navigation/native';
import { api } from '../utils/api';
import { shouldFollowTail } from '../utils/followTail';
import {
  createChannelSync,
  type ChannelSync,
  type ChannelSyncState,
} from '../utils/hubChatChannelSync';
import { hubChatStore, locateChatMarkdownCode } from '../utils/hubChatInstance';
import { createPinsLoader, type PinsState } from '../utils/hubChatPins';
import { initialPinnedList } from '@shared/utils/hubChatPins';
import { plainChatText } from '@shared/utils/hubChatUnread';
import { badgeText, hubChatRefTarget } from '../utils/hubChatMobile';
import { mergeNotices } from '../utils/hubChatMentions';
import { useAccountScoped, useHubChatSnapshot } from '../hooks/useHubChat';
import { useApp } from '../context/AppContext';
import { HubChatComposer, HubChatMessageBody } from '../components/HubChatRefs';
import HubIcon from '../components/HubIcon';
import WindowKeyboardAvoidingView from '../components/WindowKeyboardAvoidingView';
import HubChatTriggerCard from '../components/HubChatTriggerCard';
import HubChatDigestSection from '../components/HubChatDigestSection';
import HubChatSearch from '../components/HubChatSearch';
import type { HubChatSearchResult } from '@shared/utils/hubChatSearch';
import { readChatTriggerCard } from '@shared/utils/chatTriggers';
import { colors } from '../theme/colors';

/** A request to show one message in a channel; `token` makes each request distinct. */
export interface HubChatFocus {
  channelId: string;
  messageId: string;
  token: number;
}

const LINK_GONE = 'That message is no longer in this conversation.';
const HIGHLIGHT_MS = 4000;

function useUsernames(account: number): ReadonlyMap<string, string> & { list: HubChatOrgMember[] } {
  const [members, setMembers] = useState<HubChatOrgMember[]>([]);
  // Org members belong to one account: refetch, and drop the old list, on switch.
  useEffect(() => {
    let cancelled = false;
    setMembers([]);
    api.hubChat
      .members()
      .then((res: { members?: HubChatOrgMember[] }) => {
        if (!cancelled) setMembers(res?.members ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account]);
  return useMemo(() => {
    const map = new Map(members.map((m) => [m.userId, m.username])) as Map<string, string> & {
      list: HubChatOrgMember[];
    };
    map.list = members;
    return map;
  }, [members]);
}

/**
 * Agent Hub chat on mobile: the channel rail and one open channel. Google Chat
 * is its own Hub pane. Peer of the web `HubChatPage`.
 */
export default function HubChatScreen({
  initialChannelId,
  openRequest,
  onChannelChange,
  navigation,
}: {
  initialChannelId?: string | null;
  /** Bumped by the Hub screen when a push or link asks for a channel again. */
  openRequest?: number;
  /** Reports the open channel so the Hub can restore it after a tab switch. */
  onChannelChange?: (channelId: string | null) => void;
  navigation?: any;
}) {
  const { handleOpenHandoffSession } = useApp();
  // The open channel belongs to the account it was opened under.
  const [channelId, setChannelIdState] = useAccountScoped<string>(initialChannelId ?? null);
  const changeRef = useRef(onChannelChange);
  changeRef.current = onChannelChange;
  const setChannelId = useCallback(
    (id: string | null) => {
      setChannelIdState(id);
      changeRef.current?.(id);
    },
    [setChannelIdState],
  );
  const { account } = useHubChatSnapshot();
  const usernames = useUsernames(account);
  const [focus, setFocus] = useState<HubChatFocus | null>(null);
  const focusTokenRef = useRef(0);
  const showMessage = useCallback(
    (targetChannelId: string, messageId: string) => {
      setFocus({ channelId: targetChannelId, messageId, token: ++focusTokenRef.current });
      setChannelId(targetChannelId);
    },
    [setChannelId],
  );

  // A channel request is the channel plus the open counter, so a push for the
  // channel already shown still re-opens it.
  const channelRequest = initialChannelId ? `${initialChannelId}:${openRequest}` : null;
  const handledChannelRequestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!initialChannelId || !channelRequest) return;
    if (handledChannelRequestRef.current === channelRequest) return;
    handledChannelRequestRef.current = channelRequest;
    setChannelIdState(initialChannelId);
  }, [channelRequest, initialChannelId, setChannelIdState]);

  const openRef = useCallback(
    (ref: HubChatResolvedRef) => {
      const target = hubChatRefTarget(ref);
      if (!target) return;
      if (target.kind === 'session') {
        handleOpenHandoffSession(target.agentId, target.sessionId);
        navigation?.navigate?.('Chat');
        return;
      }
      navigation?.navigate?.(target.screen, target.params);
    },
    [handleOpenHandoffSession, navigation],
  );

  return (
    <View style={styles.root}>
      {channelId ? (
        <ChannelView
          key={`${account}:${channelId}`}
          channelId={channelId}
          usernames={usernames}
          onBack={() => {
            setFocus(null);
            setChannelId(null);
          }}
          onOpenRef={openRef}
          focus={focus?.channelId === channelId ? focus : null}
          onFollow={showMessage}
        />
      ) : (
        <ChannelRail
          // Remount per account so open dialogs drop lists fetched for the last one.
          key={account}
          usernames={usernames}
          onOpen={(id) => setChannelId(id)}
          onPickResult={(r) => showMessage(r.channel.id, r.message.id)}
        />
      )}
    </View>
  );
}

export function CountBadge({ count, testID }: { count: number; testID?: string }) {
  return (
    <View style={styles.badge} testID={testID}>
      <Text style={styles.badgeText}>{badgeText(count)}</Text>
    </View>
  );
}

/** One rail row: label, bold when anything is unread, a badge per the web rule. */
export function ChannelRow({
  channel,
  label,
  onPress,
  now,
}: {
  channel: HubChatChannel;
  label: string;
  onPress: () => void;
  now?: number;
}) {
  const unread = railUnread(channel, now);
  const muted = isChannelMuted(channel, now);
  return (
    <TouchableOpacity
      testID={`hub-chat-channel-${channel.id}`}
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={unread.count > 0 ? `${label}, ${unread.count} unread` : label}
    >
      <Text
        style={[styles.rowLabel, unread.bold && styles.rowLabelBold, muted && styles.rowMuted]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {unread.count > 0 ? <CountBadge count={unread.count} /> : null}
    </TouchableOpacity>
  );
}

function ChannelRail({
  usernames,
  onOpen,
  onPickResult,
}: {
  usernames: ReturnType<typeof useUsernames>;
  onOpen: (channelId: string) => void;
  onPickResult: (result: HubChatSearchResult) => void;
}) {
  const snapshot = useHubChatSnapshot();
  const [dialog, setDialog] = useState<'dm' | 'channel' | 'browse' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sections = useMemo(
    () => sectionChannels(snapshot.channels, usernames, snapshot.viewerUserId),
    [snapshot.channels, usernames, snapshot.viewerUserId],
  );

  return (
    <View style={styles.flex}>
      <View style={styles.railActions}>
        <ActionButton label="Message" onPress={() => setDialog('dm')} />
        <ActionButton label="Channel" onPress={() => setDialog('channel')} />
        <ActionButton label="Browse" onPress={() => setDialog('browse')} />
      </View>
      <HubChatSearch
        account={snapshot.account}
        usernames={usernames}
        viewerUserId={snapshot.viewerUserId}
        onPick={onPickResult}
      >
        <ScrollView style={styles.flex} contentContainerStyle={styles.railContent}>
          {!snapshot.loaded ? (
            <ActivityIndicator color={colors.gray400} style={styles.pad} />
          ) : null}
          {RAIL_SECTIONS.map((section) => {
            const list = sections[section.id];
            if (list.length === 0) return null;
            return (
              <View key={section.id} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                {list.map((c) => (
                  <ChannelRow
                    key={c.id}
                    channel={c}
                    label={channelLabel(c, usernames, snapshot.viewerUserId)}
                    onPress={() => onOpen(c.id)}
                  />
                ))}
              </View>
            );
          })}
          {snapshot.loaded && snapshot.channels.length === 0 ? (
            <Text style={[styles.muted, styles.pad]}>
              No conversations yet. Start a message or join a channel.
            </Text>
          ) : null}
          <TouchableOpacity
            style={styles.refresh}
            disabled={refreshing}
            onPress={() => {
              setRefreshing(true);
              void hubChatStore.refresh().finally(() => setRefreshing(false));
            }}
          >
            <Text style={styles.muted}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </HubChatSearch>
      <NewDmDialog
        visible={dialog === 'dm'}
        members={usernames.list}
        viewerUserId={snapshot.viewerUserId}
        onClose={() => setDialog(null)}
        onOpened={(id) => {
          setDialog(null);
          onOpen(id);
        }}
      />
      <NewChannelDialog
        visible={dialog === 'channel'}
        onClose={() => setDialog(null)}
        onCreated={(id) => {
          setDialog(null);
          onOpen(id);
        }}
      />
      <BrowseDialog
        visible={dialog === 'browse'}
        onClose={() => setDialog(null)}
        onJoined={(id) => {
          setDialog(null);
          onOpen(id);
        }}
      />
    </View>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.actionButton} onPress={onPress} accessibilityRole="button">
      <HubIcon name="Plus" size={12} color={colors.gray300} />
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ChannelView({
  channelId,
  usernames,
  onBack,
  onOpenRef,
  focus,
  onFollow,
}: {
  channelId: string;
  usernames: ReturnType<typeof useUsernames>;
  onBack: () => void;
  onOpenRef: (ref: HubChatResolvedRef) => void;
  /** A message to scroll to and highlight once the channel has loaded. */
  focus?: HubChatFocus | null;
  /** The focused message lives in another channel: show it there. */
  onFollow?: (channelId: string, messageId: string) => void;
}) {
  const snapshot = useHubChatSnapshot();
  const listed = snapshot.channels.find((c) => c.id === channelId);
  // A channel not in the rail (a public channel opened before joining).
  const [fetched, setFetched] = useState<HubChatChannel | null>(null);
  const channel = listed ?? fetched;
  const [sync, setSync] = useState<ChannelSyncState>({
    window: { messages: [], revisions: {} },
    hasMore: false,
    loading: true,
    error: null,
  });
  const win = sync.window;
  const { hasMore, loading } = sync;
  const loadError = sync.error;
  const syncRef = useRef<ChannelSync | null>(null);
  const pinsRef = useRef<ReturnType<typeof createPinsLoader> | null>(null);
  const [draft, setDraft] = useState<{ text: string; mentions: ComposerMention[] }>({
    text: '',
    mentions: [],
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [editing, setEditing] = useState<HubChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  // Mentions in this viewer's posts here that the server refused.
  const [mentionNotices, setMentionNotices] = useState<HubChatMentionNotice[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<HubChatMessage | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinsState, setPinsState] = useState<PinsState>(initialPinnedList);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  // On screen means both: the app is in front and this screen has focus. It
  // decides whether arriving messages count as read and whether reads are
  // written, so a backgrounded or covered channel keeps its unread count.
  const focused = useIsFocused();
  const visible = appActive && focused;
  const mounted = useRef(true);
  // A read write that failed is not retried for the same position until the
  // channel is on screen again, so a server error cannot loop the request.
  const failedReadRef = useRef<number | null>(null);
  // Follow new messages only while the reader is at the bottom.
  const stickToBottomRef = useRef(true);
  // The Unread line stays where it was when the channel opened.
  const [openedReadSeq, setOpenedReadSeq] = useState<number | null>(
    listed?.membership ? listed.membership.lastReadSeq : null,
  );

  // One sync controller per open channel owns every change to the window.
  useEffect(() => {
    mounted.current = true;
    setMentionNotices([]);
    const ctl = createChannelSync(channelId, api.hubChat, (next) => {
      if (mounted.current) setSync(next);
    });
    syncRef.current = ctl;
    setSync(ctl.getState());
    void ctl.load();
    const pinsLoader = createPinsLoader(channelId, api.hubChat, (next) => {
      if (mounted.current) setPinsState(next);
    });
    pinsRef.current = pinsLoader;
    setPinsState(pinsLoader.getState());
    void pinsLoader.reload();
    const offLive = hubChatStore.subscribeLive((event) => {
      if (event.type === 'resync') {
        ctl.resync();
        void pinsLoader.reload();
      } else if (event.type === 'hub_chat_message_meta') {
        ctl.receiveMeta(event.meta);
        pinsLoader.receiveMeta(event.meta);
      } else if (event.type === 'hub_chat_message' && event.message.channelId === channelId) {
        ctl.receiveNew([event.message]);
      } else if (
        event.type === 'hub_chat_message_update' &&
        event.message.channelId === channelId
      ) {
        ctl.receiveUpdate(event.message);
        pinsLoader.receiveUpdate(event.message);
      } else if (event.type === 'hub_chat_notice' && event.notice.channelId === channelId) {
        setMentionNotices((cur) => mergeNotices(cur, [event.notice]));
      }
    });
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => {
      mounted.current = false;
      ctl.dispose();
      pinsLoader.dispose();
      pinsRef.current = null;
      syncRef.current = null;
      offLive();
      sub.remove();
      if (hubChatStore.getViewing() === channelId) hubChatStore.setViewing(null);
    };
  }, [channelId]);

  // Viewing follows visibility. Coming back on screen reloads what is shown,
  // since the socket may have dropped while away.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible) {
      hubChatStore.setViewing(channelId);
      if (!wasVisible.current) {
        failedReadRef.current = null;
        syncRef.current?.resync();
      }
    } else if (hubChatStore.getViewing() === channelId) {
      hubChatStore.setViewing(null);
    }
    wasVisible.current = visible;
  }, [visible, channelId]);

  useEffect(() => {
    if (listed) return;
    api.hubChat
      .channel(channelId)
      .then((res: { channel?: HubChatChannel }) => {
        if (mounted.current && res?.channel) setFetched(res.channel);
      })
      .catch(() => {});
  }, [channelId, listed]);

  useEffect(() => {
    if (openedReadSeq === null && channel?.membership) {
      setOpenedReadSeq(channel.membership.lastReadSeq);
    }
  }, [channel?.membership, openedReadSeq]);

  const newestSeq = win.messages.length ? win.messages[win.messages.length - 1].seq : 0;

  // The rail learned the channel moved past the window (e.g. after a reconnect).
  const channelLastSeq = channel?.lastSeq ?? 0;
  useEffect(() => {
    syncRef.current?.catchUpTo(channelLastSeq);
  }, [channelLastSeq]);

  // Mark read only while the channel is on screen.
  // Compared against what the server was told (confirmed and in-flight
  // writes), not the shown pointer: that already counts messages on screen as
  // read, so it would skip writing exactly the reads this view exists for.
  // The store subscription re-renders this view on every change.
  const readSeq = hubChatStore.readWritten(channelId);
  useEffect(() => {
    if (!visible || !channel?.membership || newestSeq <= readSeq) return;
    if (failedReadRef.current === newestSeq) return;
    const seq = newestSeq;
    const settle = hubChatStore.markReadLocal(channelId, seq);
    api.hubChat.markRead(channelId, seq).then(
      () => settle(true),
      () => {
        failedReadRef.current = seq;
        settle(false);
      },
    );
  }, [visible, channel?.membership, channelId, newestSeq, readSeq]);

  // Showing a message (a search result): look up its seq, load history back
  // to it, then scroll to and highlight it. Each request gets a token; a newer
  // request or Stop supersedes it, so only the latest one acts.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [seekPending, setSeekPending] = useState<{
    token: number;
    messageId: string;
    seq: number;
  } | null>(null);
  const [seekError, setSeekError] = useState<string | null>(null);
  const [seeking, setSeeking] = useState(false);
  const seekTokenRef = useRef(0);
  const handledFocusRef = useRef<number | null>(null);
  // While a seek or its highlight is on, new content must not pull the list
  // back to the bottom.
  const holdPositionRef = useRef(false);
  const seekLive = (token: number) => mounted.current && seekTokenRef.current === token;
  const inWindow = (messageId: string) =>
    !!syncRef.current?.getState().window.messages.some((m) => m.id === messageId);

  const stopSeek = () => {
    seekTokenRef.current++;
    setSeekPending(null);
    setSeeking(false);
    holdPositionRef.current = false;
  };

  const finishSeek = async (token: number, messageId: string, seq: number) => {
    const ctl = syncRef.current;
    if (!ctl) return;
    setSeeking(true);
    let done: boolean;
    try {
      done = await ctl.loadBackTo(seq, { live: () => seekLive(token) });
    } catch (err) {
      if (!seekLive(token)) return;
      setSeeking(false);
      holdPositionRef.current = false;
      setSeekError(`Could not load earlier messages: ${errorText(err)}`);
      return;
    }
    if (!seekLive(token)) return;
    setSeeking(false);
    if (!done) {
      setSeekPending({ token, messageId, seq });
      return;
    }
    if (inWindow(messageId)) setHighlightId(messageId);
    else {
      holdPositionRef.current = false;
      setSeekError(LINK_GONE);
    }
  };

  const seekMessage = async (token: number, messageId: string) => {
    if (inWindow(messageId)) {
      setHighlightId(messageId);
      return;
    }
    let found: HubChatMessage | undefined;
    setSeeking(true);
    try {
      const res = await api.hubChat.message(messageId);
      found = res?.message as HubChatMessage | undefined;
    } catch (err) {
      if (!seekLive(token)) return;
      setSeeking(false);
      holdPositionRef.current = false;
      const status = (err as { status?: number })?.status;
      setSeekError(status === 404 ? LINK_GONE : `Could not load the message: ${errorText(err)}`);
      return;
    }
    if (!seekLive(token)) return;
    if (!found) {
      setSeeking(false);
      holdPositionRef.current = false;
      setSeekError(LINK_GONE);
      return;
    }
    if (found.channelId !== channelId) {
      setSeeking(false);
      holdPositionRef.current = false;
      onFollow?.(found.channelId, messageId);
      return;
    }
    await finishSeek(token, messageId, found.seq);
  };

  const keepSeeking = () => {
    const pending = seekPending;
    if (!pending || !seekLive(pending.token)) return;
    setSeekPending(null);
    void finishSeek(pending.token, pending.messageId, pending.seq);
  };

  useEffect(() => {
    if (!focus || loading || handledFocusRef.current === focus.token) return;
    // A failed first load leaves nothing to seek in; the request waits for
    // the reload (back on screen, reconnect) instead of being used up.
    if (loadError && win.messages.length === 0) return;
    handledFocusRef.current = focus.token;
    seekTokenRef.current++;
    const token = seekTokenRef.current;
    setSeekPending(null);
    setSeekError(null);
    holdPositionRef.current = true;
    stickToBottomRef.current = false;
    void seekMessage(token, focus.messageId);
    // seekMessage is recreated every render and reads the window through the sync ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loading, loadError]);

  const loadOlder = () => {
    if (!win.messages[0]) return;
    stickToBottomRef.current = false;
    syncRef.current
      ?.loadOlder()
      .catch((err: unknown) => Alert.alert('Could not load messages', errorText(err)));
  };

  const send = async () => {
    const sent = draftRef.current;
    if (!sent.text.trim() || sending) return;
    const body = encodeComposerMentions(sent.text, sent.mentions, locateChatMarkdownCode);
    setSending(true);
    try {
      const res = editing
        ? await api.hubChat.edit(editing.id, body)
        : await api.hubChat.post(channelId, body);
      if (res?.message) {
        if (editing) {
          syncRef.current?.receiveUpdate(res.message);
          pinsRef.current?.receiveUpdate(res.message);
        } else {
          stickToBottomRef.current = true;
          syncRef.current?.receiveNew([res.message]);
          const notices = parseMentionNotices(res.mentionNotices, {
            channelId,
            messageId: res.message.id,
          });
          if (notices.length) setMentionNotices((cur) => mergeNotices(cur, notices));
        }
      }
      // Clear only what was sent: text typed while the request was out stays.
      if (mounted.current && draftRef.current.text === sent.text) {
        setDraft({ text: '', mentions: [] });
        setEditing(null);
      }
    } catch (err) {
      Alert.alert(editing ? 'Could not save the edit' : 'Could not send', errorText(err));
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const startEdit = (m: HubChatMessage) => {
    const decoded = decodeToComposer(m.body, locateChatMarkdownCode);
    setEditing(m);
    setDraft({ text: decoded.text, mentions: decoded.mentions });
  };

  const canAct = !!channel?.membership && !channel.archivedAt;

  const applyMeta = (res: { meta?: HubChatMessageMeta }) => {
    if (!res?.meta) return;
    syncRef.current?.receiveMeta(res.meta);
    // The header list too: a pin made while the socket is down has no echo.
    pinsRef.current?.receiveMeta(res.meta);
  };

  const toggleReaction = (m: HubChatMessage, emoji: string) => {
    const mine = m.reactions?.find((r) => r.emoji === emoji);
    const request =
      mine && reactedByViewer(mine, snapshot.viewerUserId)
        ? api.hubChat.unreact(m.id, emoji)
        : api.hubChat.react(m.id, emoji);
    request.then(applyMeta).catch((err: unknown) => Alert.alert('Could not react', errorText(err)));
  };

  const setPinned = (messageId: string, pinned: boolean) => {
    (pinned ? api.hubChat.pin(messageId) : api.hubChat.unpin(messageId))
      .then(applyMeta)
      .catch((err: unknown) =>
        Alert.alert(pinned ? 'Could not pin' : 'Could not unpin', errorText(err)),
      );
  };

  const deleteMessage = (m: HubChatMessage) => {
    api.hubChat
      .remove(m.id)
      .then((res: { message?: HubChatMessage }) => {
        if (res?.message) {
          syncRef.current?.receiveUpdate(res.message);
          pinsRef.current?.receiveUpdate(res.message);
        }
      })
      .catch((err: unknown) => Alert.alert('Could not delete', errorText(err)));
  };

  const onLongPress = (m: HubChatMessage) => setActionsFor(m);

  // A pinned message: the same seek as a search result, starting from the
  // seq the pinned list already has.
  const jumpToPinned = (message: HubChatMessage) => {
    setPinsOpen(false);
    seekTokenRef.current++;
    const token = seekTokenRef.current;
    setSeekPending(null);
    setSeekError(null);
    holdPositionRef.current = true;
    stickToBottomRef.current = false;
    void finishSeek(token, message.id, message.seq);
  };

  const join = () => {
    hubChatStore
      .requestChannel(() => api.hubChat.join(channelId))
      .catch((err: unknown) => Alert.alert('Could not join', errorText(err)));
  };

  const rows = useMemo(
    () =>
      layoutHubChatMessages(win.messages, {
        viewerUserId: snapshot.viewerUserId,
        lastReadSeq: openedReadSeq,
      }),
    [win.messages, snapshot.viewerUserId, openedReadSeq],
  );
  const listRef = useRef<FlatList<any>>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const label = channel ? channelLabel(channel, usernames, snapshot.viewerUserId) : '';

  const scrollToMessage = (messageId: string, attempt = 0) => {
    const index = rowsRef.current.findIndex((r) => r.message.id === messageId);
    if (index < 0) return;
    stickToBottomRef.current = false;
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: attempt > 0 });
    } catch {
      // Not measured yet; onScrollToIndexFailed retries.
    }
  };

  useEffect(() => {
    if (!highlightId) return;
    scrollToMessage(highlightId);
    const timer = setTimeout(() => {
      setHighlightId(null);
      holdPositionRef.current = false;
    }, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  return (
    <WindowKeyboardAvoidingView style={styles.flex}>
      <View style={styles.channelHeader}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.headerButton}
          accessibilityLabel="Back to conversations"
          testID="hub-chat-back"
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.flex}>
          <Text style={styles.channelTitle} numberOfLines={1}>
            {label}
          </Text>
          {channel?.topic ? (
            <Text style={styles.muted} numberOfLines={1}>
              {channel.topic}
            </Text>
          ) : null}
          {channel?.kind === 'agent' ? (
            <View style={styles.agentStateRow} testID="hub-chat-agent-state">
              {channel.agentState?.running ? (
                <ActivityIndicator size="small" color={colors.blue400} />
              ) : null}
              <Text style={styles.muted}>{agentChannelStatus(channel.agentState)}</Text>
              {channel.agentState?.sessionId ? (
                <HubChatMessageBody
                  body={
                    formatHubChatRefToken(
                      channel.agentState.sessionName || 'Session',
                      'session',
                      channel.agentState.sessionId,
                    ) ?? ''
                  }
                  onOpenRef={onOpenRef}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => setPinsOpen(true)}
          style={styles.headerButton}
          accessibilityLabel={
            pinsState.pins.length ? `Pinned messages (${pinsState.pins.length})` : 'Pinned messages'
          }
          testID="hub-chat-pins-button"
        >
          <Text style={styles.pinButtonText}>
            📌{pinsState.pins.length ? ` ${pinsState.pins.length}` : ''}
          </Text>
        </TouchableOpacity>
        {channel?.membership ? (
          <TouchableOpacity
            onPress={() => setSettingsOpen(true)}
            style={styles.headerButton}
            accessibilityLabel="Channel settings"
          >
            <HubIcon name="Settings" size={16} color={colors.gray400} />
          </TouchableOpacity>
        ) : null}
      </View>
      {seeking ? (
        <View style={styles.seekBar} testID="hub-chat-seeking">
          <ActivityIndicator size="small" color={colors.gray400} />
          <Text style={[styles.muted, styles.flex]}>Finding the message…</Text>
          <TouchableOpacity onPress={stopSeek} accessibilityRole="button">
            <Text style={styles.link}>Stop</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {seekPending && !seeking ? (
        <View style={styles.seekBar} testID="hub-chat-seek-pending">
          <Text style={[styles.muted, styles.flex]}>
            The message is{' '}
            {Math.max(1, (win.messages[0]?.seq ?? seekPending.seq) - seekPending.seq)} messages
            further back.
          </Text>
          <TouchableOpacity onPress={keepSeeking} accessibilityRole="button">
            <Text style={styles.link}>Keep loading</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={stopSeek} accessibilityRole="button">
            <Text style={styles.link}>Stop</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {seekError ? (
        <View style={styles.seekBar} testID="hub-chat-seek-error">
          <Text style={[styles.error, styles.flex]}>{seekError}</Text>
          <TouchableOpacity onPress={() => setSeekError(null)} accessibilityLabel="Dismiss">
            <HubIcon name="X" size={14} color={colors.gray400} />
          </TouchableOpacity>
        </View>
      ) : null}
      {loading && win.messages.length === 0 ? (
        <ActivityIndicator color={colors.gray400} style={styles.pad} />
      ) : loadError && win.messages.length === 0 ? (
        <Text style={[styles.error, styles.pad]}>{loadError}</Text>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={styles.messages}
          data={rows}
          keyExtractor={(r) => r.message.id}
          // Prepending older pages keeps the message the reader was looking at
          // in place; new messages scroll into view only while at the bottom.
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
            if (stickToBottomRef.current && !holdPositionRef.current) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          extraData={highlightId}
          onScrollToIndexFailed={(info) => {
            // The row is outside what has been laid out: jump near it, then retry.
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            const id = highlightId;
            if (id) setTimeout(() => mounted.current && scrollToMessage(id, 1), 100);
          }}
          ListHeaderComponent={
            hasMore ? (
              <TouchableOpacity onPress={loadOlder} style={styles.loadOlder}>
                <Text style={styles.muted}>Load earlier messages</Text>
              </TouchableOpacity>
            ) : null
          }
          ListEmptyComponent={<Text style={[styles.muted, styles.pad]}>No messages yet.</Text>}
          renderItem={({ item }) => (
            <MessageRow
              row={item}
              highlighted={item.message.id === highlightId}
              usernames={usernames}
              onOpenRef={onOpenRef}
              viewerUserId={snapshot.viewerUserId}
              onLongPress={
                !item.message.deletedAt && (canAct || item.own) ? onLongPress : undefined
              }
              onToggleReaction={canAct ? toggleReaction : undefined}
            />
          )}
        />
      )}
      {channel && !channel.membership ? (
        <TouchableOpacity style={styles.joinBar} onPress={join} accessibilityRole="button">
          <Text style={styles.joinText}>Join channel</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.composer}>
          <MentionStatus
            pendingText={mentionPendingText(channel?.mentionPending ?? [])}
            notices={mentionNotices}
            onDismissNotice={(key) => setMentionNotices((cur) => cur.filter((n) => n.key !== key))}
          />
          {editing ? (
            <View style={styles.editingBar}>
              <Text style={styles.muted}>Editing message</Text>
              <TouchableOpacity
                onPress={() => {
                  setEditing(null);
                  setDraft({ text: '', mentions: [] });
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <View style={styles.composerRow}>
            <View style={styles.flex}>
              <HubChatComposer
                value={draft.text}
                mentions={draft.mentions}
                onChange={(text, mentions) => setDraft({ text, mentions })}
                placeholder={label ? `Message ${label}` : 'Message'}
                placeholderTextColor={colors.gray500}
                multiline
                style={styles.input}
                testID="hub-chat-input"
              />
            </View>
            <TouchableOpacity
              onPress={() => void send()}
              disabled={sending || !draft.text.trim()}
              style={[styles.sendButton, (sending || !draft.text.trim()) && styles.disabled]}
              accessibilityLabel={editing ? 'Save edit' : 'Send'}
              testID="hub-chat-send"
            >
              <Text style={styles.sendText}>{editing ? 'Save' : 'Send'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      <MessageActionsSheet
        message={actionsFor}
        own={
          !!actionsFor &&
          actionsFor.authorUserId === snapshot.viewerUserId &&
          actionsFor.authorKind === 'user'
        }
        canAct={canAct}
        viewerUserId={snapshot.viewerUserId}
        onClose={() => setActionsFor(null)}
        onReact={(m, emoji) => {
          setActionsFor(null);
          toggleReaction(m, emoji);
        }}
        onPin={(m) => {
          setActionsFor(null);
          setPinned(m.id, !m.pinned);
        }}
        onEdit={(m) => {
          setActionsFor(null);
          startEdit(m);
        }}
        onDelete={(m) => {
          setActionsFor(null);
          Alert.alert('Delete this message?', undefined, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => deleteMessage(m) },
          ]);
        }}
      />
      <PinsDialog
        visible={pinsOpen}
        state={pinsState}
        usernames={usernames}
        canUnpin={canAct}
        onClose={() => setPinsOpen(false)}
        onPick={jumpToPinned}
        onUnpin={(id) => setPinned(id, false)}
      />
      {channel ? (
        <ChannelSettingsDialog
          visible={settingsOpen}
          channel={channel}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </WindowKeyboardAvoidingView>
  );
}

function timeLabel(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function MessageRow({
  row,
  usernames,
  onOpenRef,
  onLongPress,
  highlighted,
  viewerUserId = null,
  onToggleReaction,
}: {
  row: ReturnType<typeof layoutHubChatMessages>[number];
  highlighted?: boolean;
  usernames: ReadonlyMap<string, string>;
  onOpenRef?: (ref: HubChatResolvedRef) => void;
  onLongPress?: (m: HubChatMessage) => void;
  viewerUserId?: string | null;
  onToggleReaction?: (m: HubChatMessage, emoji: string) => void;
}) {
  const m = row.message;
  const triggerCard = m.authorKind === 'trigger' ? readChatTriggerCard(m.payload) : null;
  return (
    <View>
      {row.dayLabel ? (
        <View style={styles.dayDivider}>
          <Text style={styles.dayLabel}>{row.dayLabel}</Text>
        </View>
      ) : null}
      {row.unreadDivider ? (
        <View style={styles.unreadDivider} testID="hub-chat-unread-line">
          <Text style={styles.unreadLabel}>Unread</Text>
        </View>
      ) : null}
      <TouchableOpacity
        activeOpacity={onLongPress ? 0.7 : 1}
        onLongPress={onLongPress ? () => onLongPress(m) : undefined}
        style={[
          styles.message,
          row.showHeader && styles.messageFirst,
          highlighted && styles.messageHighlighted,
        ]}
        testID={highlighted ? 'hub-chat-message-highlighted' : undefined}
      >
        {row.showHeader ? (
          <View style={styles.messageHeader}>
            <Text style={[styles.author, row.own && styles.authorOwn]}>
              {authorLabel(m, usernames)}
            </Text>
            <Text style={styles.time}>{timeLabel(m.createdAt)}</Text>
          </View>
        ) : null}
        {m.deletedAt ? (
          <Text style={styles.deleted}>Message deleted</Text>
        ) : triggerCard ? (
          <HubChatTriggerCard card={triggerCard} onOpenRef={onOpenRef} />
        ) : (
          <>
            <HubChatMessageBody body={m.body} onOpenRef={onOpenRef} />
            {m.editedAt ? <Text style={styles.time}>(edited)</Text> : null}
          </>
        )}
        {!m.deletedAt && m.pinned ? (
          <Text style={styles.pinnedLabel} testID="hub-chat-pinned-label">
            📌 Pinned
            {m.pinned.byUserId && usernames.get(m.pinned.byUserId)
              ? ` by ${usernames.get(m.pinned.byUserId)}`
              : ''}
          </Text>
        ) : null}
        {!m.deletedAt && m.reactions?.length ? (
          <View style={styles.reactionRow} testID="hub-chat-reactions">
            {m.reactions.map((r) => {
              const mine = reactedByViewer(r, viewerUserId);
              return (
                <TouchableOpacity
                  key={r.emoji}
                  disabled={!onToggleReaction}
                  onPress={() => onToggleReaction?.(m, r.emoji)}
                  style={[styles.reactionChip, mine && styles.reactionChipMine]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: mine }}
                  accessibilityLabel={`${r.emoji} ${r.count}`}
                  testID="hub-chat-reaction"
                >
                  <Text style={styles.reactionText}>
                    {r.emoji} {r.count}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
      </TouchableOpacity>
    </View>
  );
}

/**
 * Mentioned agents still answering here (for every member, from the server)
 * and the viewer's own refused mentions.
 */
export function MentionStatus({
  pendingText,
  notices,
  onDismissNotice,
}: {
  pendingText: string | null;
  notices: HubChatMentionNotice[];
  onDismissNotice: (key: string) => void;
}) {
  if (!pendingText && notices.length === 0) return null;
  return (
    <View style={styles.mentionStatus} testID="hub-chat-mention-status">
      {pendingText ? (
        <View
          style={styles.mentionRow}
          testID="hub-chat-mention-pending"
          accessibilityRole="progressbar"
        >
          <ActivityIndicator size="small" color={colors.blue400} />
          <Text style={[styles.muted, styles.mentionText]} numberOfLines={2}>
            {pendingText}
          </Text>
        </View>
      ) : null}
      {notices.map((n) => (
        <View key={n.key} style={styles.mentionRow} testID="hub-chat-mention-notice">
          <Text style={[styles.mentionNotice, styles.mentionText]}>{n.message}</Text>
          <TouchableOpacity
            onPress={() => onDismissNotice(n.key)}
            accessibilityLabel="Dismiss notice"
            hitSlop={8}
          >
            <HubIcon name="X" size={14} color={colors.gray400} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

/** Long-press sheet: quick reactions, pin, and the author's edit/delete. */
function MessageActionsSheet({
  message,
  own,
  canAct,
  viewerUserId,
  onClose,
  onReact,
  onPin,
  onEdit,
  onDelete,
}: {
  message: HubChatMessage | null;
  own: boolean;
  canAct: boolean;
  viewerUserId: string | null;
  onClose: () => void;
  onReact: (m: HubChatMessage, emoji: string) => void;
  onPin: (m: HubChatMessage) => void;
  onEdit: (m: HubChatMessage) => void;
  onDelete: (m: HubChatMessage) => void;
}) {
  return (
    <DialogShell visible={!!message} title="Message" onClose={onClose}>
      {message ? (
        <View testID="hub-chat-message-actions">
          {canAct ? (
            <>
              <View style={styles.reactionPickRow}>
                {HUB_CHAT_QUICK_REACTIONS.map((emoji) => {
                  const r = message.reactions?.find((x) => x.emoji === emoji);
                  const mine = !!r && reactedByViewer(r, viewerUserId);
                  return (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => onReact(message, emoji)}
                      style={[styles.reactionPick, mine && styles.reactionChipMine]}
                      accessibilityLabel={`React with ${emoji}`}
                    >
                      <Text style={styles.reactionPickText}>{emoji}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={styles.sheetAction} onPress={() => onPin(message)}>
                <Text style={styles.sheetActionText}>
                  {message.pinned ? 'Unpin from channel' : 'Pin to channel'}
                </Text>
              </TouchableOpacity>
            </>
          ) : null}
          {own ? (
            <>
              <TouchableOpacity style={styles.sheetAction} onPress={() => onEdit(message)}>
                <Text style={styles.sheetActionText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sheetAction} onPress={() => onDelete(message)}>
                <Text style={[styles.sheetActionText, styles.error]}>Delete</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : null}
    </DialogShell>
  );
}

function PinsDialog({
  visible,
  state,
  usernames,
  canUnpin,
  onClose,
  onPick,
  onUnpin,
}: {
  visible: boolean;
  state: PinsState;
  usernames: ReadonlyMap<string, string>;
  canUnpin: boolean;
  onClose: () => void;
  onPick: (message: HubChatMessage) => void;
  onUnpin: (messageId: string) => void;
}) {
  return (
    <DialogShell visible={visible} title="Pinned messages" onClose={onClose}>
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {state.loading && state.pins.length === 0 ? (
        <ActivityIndicator color={colors.gray400} style={styles.pad} />
      ) : state.pins.length === 0 ? (
        <Text style={[styles.muted, styles.pad]}>
          Nothing pinned yet. Long-press a message to pin it.
        </Text>
      ) : (
        <ScrollView style={styles.sheetList}>
          {state.pins.map((p) => (
            <View key={p.message.id} style={styles.pinRow} testID="hub-chat-pin">
              <TouchableOpacity style={styles.flex} onPress={() => onPick(p.message)}>
                <Text style={styles.author}>{authorLabel(p.message, usernames)}</Text>
                <Text style={styles.pinText} numberOfLines={3}>
                  {plainChatText(p.message.body) || '(no text)'}
                </Text>
                <Text style={styles.time}>
                  Pinned by {(p.pinnedByUserId && usernames.get(p.pinnedByUserId)) || 'someone'}
                </Text>
              </TouchableOpacity>
              {canUnpin ? (
                <TouchableOpacity
                  onPress={() => onUnpin(p.message.id)}
                  accessibilityLabel="Unpin"
                  style={styles.headerButton}
                >
                  <HubIcon name="X" size={14} color={colors.gray400} />
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
    </DialogShell>
  );
}

function DialogShell({
  visible,
  title,
  onClose,
  fullHeight = false,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  /** Fill the screen height so long forms (digest editor) are not cramped. */
  fullHeight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, fullHeight && styles.sheetFull]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
              <HubIcon name="X" size={18} color={colors.gray400} />
            </TouchableOpacity>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NewDmDialog({
  visible,
  members,
  viewerUserId,
  onClose,
  onOpened,
}: {
  visible: boolean;
  members: HubChatOrgMember[];
  viewerUserId: string | null;
  onClose: () => void;
  onOpened: (channelId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = members
    .filter((m) => m.username.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.username.localeCompare(b.username));
  const open = (userId: string) => {
    setBusy(true);
    hubChatStore
      .requestChannel(() => api.hubChat.openDm(userId))
      .then((channel) => {
        if (channel) onOpened(channel.id);
      })
      .catch((err: unknown) => Alert.alert('Could not open the conversation', errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <DialogShell visible={visible} title="New message" onClose={onClose}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="Search people"
        placeholderTextColor={colors.gray500}
        style={styles.field}
        autoCapitalize="none"
      />
      <ScrollView style={styles.sheetList}>
        {shown.map((m) => (
          <TouchableOpacity
            key={m.userId}
            style={styles.row}
            disabled={busy}
            onPress={() => open(m.userId)}
          >
            <Text style={styles.rowLabel}>
              {m.username}
              {m.userId === viewerUserId ? ' (you)' : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </DialogShell>
  );
}

function NewChannelDialog({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
}) {
  const [kind, setKind] = useState<'channel' | 'agent'>('channel');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<unknown[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agentId, setAgentId] = useState('');
  const isAgent = kind === 'agent';
  const agentOptions = useMemo(
    () => agentChannelAgentOptions(agents, projectId),
    [agents, projectId],
  );
  const canCreate = isAgent ? !!agentId : !!name.trim();

  useEffect(() => {
    if (!visible || !isAgent) return;
    let cancelled = false;
    Promise.all([api.getProjects(), api.getAgents()])
      .then(([p, a]) => {
        if (cancelled) return;
        const list = (Array.isArray(p) ? p : [])
          .filter((x: { id?: unknown }) => !isHubSystemProject(x as { id: string }))
          .map((x: { id: unknown; name?: unknown }) => ({
            id: String(x.id),
            name: typeof x.name === 'string' && x.name ? x.name : String(x.id),
          }));
        const agentList = Array.isArray(a) ? (a as unknown[]) : [];
        setProjects(list);
        setAgents(agentList);
        const first = list.find((x) => agentChannelAgentOptions(agentList, x.id).length);
        setProjectId(first?.id ?? '');
        setAgentId(first ? (agentChannelAgentOptions(agentList, first.id)[0]?.id ?? '') : '');
      })
      .catch((err: unknown) => Alert.alert('Could not load agents', errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [visible, isAgent]);

  const create = () => {
    if (!canCreate) return;
    setBusy(true);
    hubChatStore
      .requestChannel(() =>
        api.hubChat.createChannel({
          kind,
          name: name.trim() || undefined,
          topic: topic.trim() || null,
          isPrivate,
          ...(isAgent ? { projectId, agentId } : {}),
        }),
      )
      .then((channel) => {
        if (!channel) return;
        setName('');
        setTopic('');
        setIsPrivate(false);
        setKind('channel');
        onCreated(channel.id);
      })
      .catch((err: unknown) => Alert.alert('Could not create the channel', errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <DialogShell visible={visible} title="New channel" onClose={onClose}>
      <View style={styles.chipRow} accessibilityRole="radiogroup">
        {(
          [
            ['channel', 'Channel'],
            ['agent', 'Agent channel'],
          ] as const
        ).map(([value, label]) => (
          <TouchableOpacity
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: kind === value }}
            onPress={() => setKind(value)}
            style={[styles.chip, kind === value && styles.chipActive]}
            disabled={busy}
          >
            <Text style={styles.rowLabel}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {isAgent ? (
        <>
          <Text style={styles.muted}>
            Posts run in one session on this agent, owned by you. Replies are posted back here.
          </Text>
          <Text style={styles.rowLabel}>Project</Text>
          <View style={styles.chipRow}>
            {projects.map((p) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => {
                  setProjectId(p.id);
                  setAgentId(agentChannelAgentOptions(agents, p.id)[0]?.id ?? '');
                }}
                style={[styles.chip, projectId === p.id && styles.chipActive]}
                disabled={busy}
              >
                <Text style={styles.rowLabel}>{p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.rowLabel}>Agent</Text>
          <View style={styles.chipRow}>
            {agentOptions.map((a) => (
              <TouchableOpacity
                key={a.id}
                onPress={() => setAgentId(a.id)}
                style={[styles.chip, agentId === a.id && styles.chipActive]}
                disabled={busy}
              >
                <Text style={styles.rowLabel}>{a.name}</Text>
              </TouchableOpacity>
            ))}
            {!agentOptions.length ? <Text style={styles.muted}>No agents</Text> : null}
          </View>
        </>
      ) : null}
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={isAgent ? 'Name (optional)' : 'Name'}
        placeholderTextColor={colors.gray500}
        style={styles.field}
        autoCapitalize="none"
        editable={!busy}
      />
      <TextInput
        value={topic}
        onChangeText={setTopic}
        placeholder="Topic (optional)"
        placeholderTextColor={colors.gray500}
        style={styles.field}
        editable={!busy}
      />
      <View style={styles.switchRow}>
        <Text style={styles.rowLabel}>Private</Text>
        <Switch value={isPrivate} onValueChange={setIsPrivate} disabled={busy} />
      </View>
      <TouchableOpacity
        style={[styles.primary, (busy || !canCreate) && styles.disabled]}
        disabled={busy || !canCreate}
        onPress={create}
      >
        <Text style={styles.sendText}>Create</Text>
      </TouchableOpacity>
    </DialogShell>
  );
}

function BrowseDialog({
  visible,
  onClose,
  onJoined,
}: {
  visible: boolean;
  onClose: () => void;
  onJoined: (channelId: string) => void;
}) {
  const [channels, setChannels] = useState<HubChatChannel[] | null>(null);
  useEffect(() => {
    if (!visible) return;
    setChannels(null);
    api.hubChat
      .browse()
      .then((res: { channels?: HubChatChannel[] }) => setChannels(res?.channels ?? []))
      .catch(() => setChannels([]));
  }, [visible]);
  const join = (id: string) => {
    hubChatStore
      .requestChannel(() => api.hubChat.join(id))
      .then((channel) => {
        if (channel) onJoined(id);
      })
      .catch((err: unknown) => Alert.alert('Could not join', errorText(err)));
  };
  return (
    <DialogShell visible={visible} title="Browse channels" onClose={onClose}>
      {channels === null ? <ActivityIndicator color={colors.gray400} /> : null}
      {channels && channels.length === 0 ? (
        <Text style={styles.muted}>No channels to join.</Text>
      ) : null}
      <ScrollView style={styles.sheetList}>
        {(channels ?? []).map((c) => (
          <TouchableOpacity key={c.id} style={styles.row} onPress={() => join(c.id)}>
            <View style={styles.flex}>
              <Text style={styles.rowLabel}># {c.name}</Text>
              {c.topic ? <Text style={styles.muted}>{c.topic}</Text> : null}
            </View>
            <Text style={styles.link}>Join</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </DialogShell>
  );
}

const NOTIFY_OPTIONS: { level: HubChatNotifyLevel; label: string }[] = [
  { level: 'all', label: 'All messages' },
  { level: 'mentions', label: 'Mentions only' },
  { level: 'none', label: 'Nothing' },
];

function ChannelSettingsDialog({
  visible,
  channel,
  onClose,
}: {
  visible: boolean;
  channel: HubChatChannel;
  onClose: () => void;
}) {
  const muted = isChannelMuted(channel);
  const level = channel.membership?.notifyLevel ?? 'all';
  // Both controls go through one ordered writer, so a slow earlier response
  // cannot undo a later choice.
  const save = (
    patch: { notifyLevel?: HubChatNotifyLevel; mutedUntil?: string | null },
    write: () => Promise<any>,
  ) => {
    hubChatStore
      .updateMembership(channel.id, patch, write)
      .catch((err: unknown) => Alert.alert('Could not save', errorText(err)));
  };
  const setLevel = (next: HubChatNotifyLevel) =>
    save({ notifyLevel: next }, () => api.hubChat.setNotifyLevel(channel.id, next));
  const setMute = (until: string | null) =>
    save({ mutedUntil: until }, () => api.hubChat.setMute(channel.id, until));
  return (
    <DialogShell visible={visible} title="Channel settings" onClose={onClose} fullHeight>
      <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>Notifications</Text>
        {NOTIFY_OPTIONS.map((o) => (
          <TouchableOpacity
            key={o.level}
            style={styles.row}
            onPress={() => setLevel(o.level)}
            accessibilityRole="radio"
            accessibilityState={{ selected: level === o.level }}
          >
            <Text style={[styles.rowLabel, level === o.level && styles.rowLabelBold]}>
              {level === o.level ? '● ' : '○ '}
              {o.label}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={[styles.sectionLabel, styles.pad]}>Mute</Text>
        {muted ? (
          <TouchableOpacity style={styles.row} onPress={() => setMute(null)}>
            <Text style={styles.link}>Unmute</Text>
          </TouchableOpacity>
        ) : (
          MUTE_PRESETS.map((p) => (
            <TouchableOpacity
              key={p.label}
              style={styles.row}
              onPress={() => setMute(muteUntilIso(p.hours))}
            >
              <Text style={styles.rowLabel}>{p.label}</Text>
            </TouchableOpacity>
          ))
        )}
        {visible && channel.membership && !channel.archivedAt && (
          <HubChatDigestSection channelId={channel.id} channelProjectId={channel.projectId} />
        )}
      </ScrollView>
    </DialogShell>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.gray950 },
  flex: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: colors.gray400, fontSize: 12 },
  error: { color: colors.red400, fontSize: 13 },
  pad: { padding: 12 },
  link: { color: colors.blue400, fontSize: 13 },
  disabled: { opacity: 0.5 },
  agentStateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  mentionStatus: { gap: 4, paddingBottom: 6 },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mentionText: { flexShrink: 1 },
  mentionNotice: { color: colors.amber400, fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.blue600,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  railActions: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray900,
  },
  actionLabel: { color: colors.gray300, fontSize: 12 },
  railContent: { paddingBottom: 24 },
  section: { marginTop: 8 },
  sectionLabel: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowLabel: { color: colors.gray300, fontSize: 14, flexShrink: 1, flexGrow: 1 },
  rowLabelBold: { color: colors.white, fontWeight: '700' },
  rowMuted: { color: colors.gray500 },
  refresh: { alignItems: 'center', padding: 12 },
  channelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  headerButton: { padding: 6 },
  backText: { color: colors.gray300, fontSize: 24, lineHeight: 24 },
  channelTitle: { color: colors.white, fontSize: 15, fontWeight: '600' },
  messages: { paddingHorizontal: 12, paddingVertical: 8 },
  loadOlder: { alignItems: 'center', padding: 8 },
  dayDivider: { alignItems: 'center', marginVertical: 8 },
  dayLabel: { color: colors.gray500, fontSize: 11, fontWeight: '600' },
  unreadDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.red500,
    marginVertical: 6,
    alignItems: 'flex-end',
  },
  unreadLabel: { color: colors.red400, fontSize: 10, fontWeight: '700' },
  message: { paddingVertical: 1 },
  messageFirst: { marginTop: 8 },
  messageHighlighted: { backgroundColor: 'rgba(234,179,8,0.15)', borderRadius: 4 },
  seekBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  messageHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  author: { color: colors.gray100, fontSize: 13, fontWeight: '700' },
  authorOwn: { color: colors.blue300 },
  time: { color: colors.gray500, fontSize: 11 },
  deleted: { color: colors.gray500, fontStyle: 'italic', fontSize: 13 },
  pinButtonText: { color: colors.gray300, fontSize: 13 },
  pinnedLabel: { color: colors.amber400, fontSize: 11, marginTop: 2 },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionChip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  reactionChipMine: { borderColor: colors.blue400, backgroundColor: colors.blue600 },
  reactionText: { color: colors.gray100, fontSize: 12 },
  reactionPickRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 },
  reactionPick: { borderRadius: 8, padding: 6 },
  reactionPickText: { fontSize: 24 },
  sheetAction: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.gray800 },
  sheetActionText: { color: colors.gray100, fontSize: 15 },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  pinText: { color: colors.gray300, fontSize: 13, marginVertical: 2 },
  joinBar: {
    margin: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.blue600,
    alignItems: 'center',
  },
  joinText: { color: colors.white, fontWeight: '600' },
  composer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray800,
  },
  editingBar: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    color: colors.white,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 120,
    fontSize: 14,
  },
  sendButton: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.blue600,
  },
  sendText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.black60 },
  sheet: {
    backgroundColor: colors.gray900,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    padding: 16,
    maxHeight: '80%',
    gap: 8,
  },
  sheetFull: { height: '94%', maxHeight: '94%' },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sheetTitle: { color: colors.white, fontSize: 16, fontWeight: '600' },
  sheetList: { maxHeight: 360 },
  field: {
    color: colors.white,
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  primary: {
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.blue600,
  },
});
