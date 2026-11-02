import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import BrandLogo from '../components/BrandLogo';
import { serverAgentDisplayName, useServerAgentSettings } from '../utils/serverAgentInstance';
import {
  buildSimpleContacts,
  filterSimpleContacts,
  isSimpleConsultSession,
  moveSimpleContact,
  orderSimpleContacts,
  preferredSimpleSession,
  readSimpleRosterOrder,
  readSimpleSessionId,
  reconcileSimpleRosterOrder,
  sessionShowsNeedsYou,
  takePreSimpleTarget,
  writeShellMode,
  writeSimpleRosterOrder,
  writeSimpleSessionId,
  type SimpleAgent,
  type SimpleContact,
  type SimpleContactStatus,
  type SimpleSession,
} from '../utils/simpleShell';

/**
 * First screen of the native simple shell: Server Agent pinned, then the
 * project chats in a saved order. A chat opens on the next screen.
 */
export default function SimpleChatsScreen() {
  const navigation = useNavigation<any>();
  const focused = useIsFocused();
  const {
    agents,
    projects,
    activeAgentId,
    activeTasks,
    finalizeStatusBySession,
    needsInputBySession,
    hubSessionId,
    handleOpenHandoffSession,
    setActiveSessionId,
  } = useApp();
  const settings = useServerAgentSettings();
  const serverName = serverAgentDisplayName(settings);
  const [query, setQuery] = useState('');
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [orderReady, setOrderReady] = useState(false);
  const [sessionsByAgentId, setSessionsByAgentId] = useState<
    Record<string, SimpleSession[] | undefined>
  >({});
  const [rememberedSessionIds, setRememberedSessionIds] = useState<Record<string, string | null>>(
    {},
  );
  const [movingId, setMovingId] = useState<string | null>(null);

  const rosterAgents = useMemo((): SimpleAgent[] => {
    const projectName = new Map((projects || []).map((project: any) => [project.id, project.name]));
    return (agents || []).map((agent: any) => ({
      id: agent.id,
      name: agent.name,
      color: agent.color,
      projectId: agent.projectId,
      projectName: projectName.get(agent.projectId) || '',
      role: agent.role,
      active: agent.active,
    }));
  }, [agents, projects]);

  useEffect(() => {
    let live = true;
    void readSimpleRosterOrder().then((order) => {
      if (!live) return;
      setSavedOrder(order);
      setOrderReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const agentIdsKey = rosterAgents.map((agent) => agent.id).join('\n');
  // Reload on every return to the list so chats started or changed on the
  // chat screen show their preview and status here.
  useEffect(() => {
    if (!agentIdsKey || !focused) return;
    let live = true;
    const ids = agentIdsKey.split('\n');
    void (async () => {
      const nextSessions: Record<string, SimpleSession[]> = {};
      const nextRemembered: Record<string, string | null> = {};
      await Promise.all(
        ids.map(async (agentId) => {
          nextRemembered[agentId] = await readSimpleSessionId(agentId);
          try {
            const rows = await api.getSessions(agentId);
            nextSessions[agentId] = Array.isArray(rows) ? rows : [];
          } catch {
            nextSessions[agentId] = [];
          }
        }),
      );
      if (!live) return;
      setSessionsByAgentId(nextSessions);
      setRememberedSessionIds(nextRemembered);
    })();
    return () => {
      live = false;
    };
  }, [agentIdsKey, focused]);

  const built = useMemo(
    () =>
      buildSimpleContacts({
        agents: rosterAgents,
        sessionsByAgentId,
        activeTaskSessionIds: activeTasks,
        finalizeStatusBySession,
        needsInputBySession,
        rememberedSessionIds,
      }),
    [
      rosterAgents,
      sessionsByAgentId,
      activeTasks,
      finalizeStatusBySession,
      needsInputBySession,
      rememberedSessionIds,
    ],
  );

  const builtIdsKey = built.map((contact) => contact.agentId).join('\n');
  useEffect(() => {
    if (!orderReady || !builtIdsKey) return;
    const ids = builtIdsKey.split('\n');
    const next = reconcileSimpleRosterOrder(savedOrder, ids);
    if (next.join('\n') === savedOrder.join('\n')) return;
    setSavedOrder(next);
    void writeSimpleRosterOrder(next);
  }, [builtIdsKey, orderReady, savedOrder]);

  const ordered = useMemo(() => orderSimpleContacts(built, savedOrder), [built, savedOrder]);
  const visible = useMemo(() => filterSimpleContacts(ordered, query), [ordered, query]);
  const reorderable = query.trim().length === 0;
  useEffect(() => {
    if (!reorderable) setMovingId(null);
  }, [reorderable]);

  const serverStatus = useMemo((): SimpleContactStatus => {
    if (!hubSessionId) return 'idle';
    const session = { id: hubSessionId, session_mode: 'hub' };
    if (
      sessionShowsNeedsYou(session, {
        activeTaskSessionIds: activeTasks,
        finalizeStatusBySession,
        needsInputBySession,
      })
    ) {
      return 'needs-you';
    }
    if (activeTasks?.[hubSessionId]) return 'working';
    return 'idle';
  }, [hubSessionId, activeTasks, finalizeStatusBySession, needsInputBySession]);
  const serverPreview =
    serverStatus === 'needs-you'
      ? 'Needs you'
      : serverStatus === 'working'
        ? 'Working…'
        : 'Ask anything';
  const serverContact: SimpleContact = {
    agentId: '__server__',
    name: serverName,
    projectName: '',
    color: '#38bdf8',
    preview: serverPreview,
    status: serverStatus,
    sessionId: hubSessionId ?? null,
    updatedAt: '',
  };
  const serverVisible = filterSimpleContacts([serverContact], query).length > 0;

  // Bumped by every navigation from this list and when it loses focus. A
  // chat open waits on storage and the API, and commits only if nothing else
  // was chosen meanwhile, so a slow response cannot replace a later choice.
  const navGenerationRef = useRef(0);
  useEffect(() => {
    if (!focused) navGenerationRef.current += 1;
  }, [focused]);

  const consultOpenByAgentRef = useRef(new Map<string, { owner: number; promise: Promise<any> }>());

  const openServer = useCallback(async () => {
    const generation = ++navGenerationRef.current;
    setMovingId(null);
    await writeShellMode('simple');
    if (navGenerationRef.current !== generation) return;
    navigation.navigate('SimpleChat', { kind: 'server' });
  }, [navigation]);

  const openAgent = useCallback(
    async (agentId: string) => {
      if (movingId) {
        const next = moveSimpleContact(
          ordered.map((contact) => contact.agentId),
          movingId,
          agentId,
        );
        setMovingId(null);
        if (next) {
          setSavedOrder(next);
          await writeSimpleRosterOrder(next);
        }
        return;
      }
      const generation = ++navGenerationRef.current;
      const superseded = () => navGenerationRef.current !== generation;
      try {
        await writeShellMode('simple');
        // The whole find-or-create runs once per agent at a time. A second
        // tap joins it and becomes its owner; the create only starts if the
        // owner still holds the navigation, so overlapping list requests or a
        // tap elsewhere cannot leave an extra empty chat behind.
        let op = consultOpenByAgentRef.current.get(agentId);
        if (op) {
          op.owner = generation;
        } else {
          const entry = { owner: generation, promise: Promise.resolve<any>(null) };
          entry.promise = (async () => {
            const known = sessionsByAgentId[agentId] || [];
            let consults = known.filter(isSimpleConsultSession);
            if (consults.length === 0) {
              const rows = await api.getSessions(agentId);
              consults = (Array.isArray(rows) ? rows : []).filter(isSimpleConsultSession);
            }
            const remembered =
              rememberedSessionIds[agentId] ?? (await readSimpleSessionId(agentId));
            const found = preferredSimpleSession(consults, remembered);
            if (found) return found;
            if (navGenerationRef.current !== entry.owner) return null;
            const created = await api.createSession(agentId, 'Chat', { consultMode: true });
            if (!created?.id) return null;
            setSessionsByAgentId((current) => ({
              ...current,
              [agentId]: [
                created,
                ...(current[agentId] || []).filter((row) => row.id !== created.id),
              ],
            }));
            return created;
          })().finally(() => consultOpenByAgentRef.current.delete(agentId));
          consultOpenByAgentRef.current.set(agentId, entry);
          op = entry;
        }
        const chosen = await op.promise;
        // Selection state is written only by the open that still owns the
        // navigation, so a superseded open cannot change the remembered chat.
        if (superseded()) return;
        if (!chosen?.id) throw new Error('No chat to open');
        const target = chosen;
        setRememberedSessionIds((current) => ({ ...current, [agentId]: target.id }));
        await writeSimpleSessionId(agentId, target.id);
        if (superseded()) return;
        // A different agent reloads its session list; pin the loader to this
        // consult chat so it does not jump to a newer build session.
        if (agentId !== activeAgentId) handleOpenHandoffSession(agentId, target.id);
        else setActiveSessionId(target.id);
        navigation.navigate('SimpleChat', { kind: 'agent', agentId, sessionId: target.id });
      } catch {
        if (!superseded()) Alert.alert('Chat', 'Could not open this chat.');
      }
    },
    [
      movingId,
      ordered,
      navigation,
      sessionsByAgentId,
      rememberedSessionIds,
      activeAgentId,
      handleOpenHandoffSession,
      setActiveSessionId,
    ],
  );

  const openFullHub = useCallback(async () => {
    const generation = ++navGenerationRef.current;
    await writeShellMode('hub');
    const target = await takePreSimpleTarget();
    if (navGenerationRef.current !== generation) return;
    if (target) {
      // Pin the loader: the target's agent may differ from the active one.
      handleOpenHandoffSession(target.agentId, target.sessionId);
      navigation.navigate('Chat');
      return;
    }
    navigation.navigate('Hub');
  }, [handleOpenHandoffSession, navigation]);

  const movingName = ordered.find((contact) => contact.agentId === movingId)?.name;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <Text style={styles.subtitle}>Chat here. Hand off a build when you need one.</Text>
        <Pressable
          testID="simple-full-hub"
          accessibilityRole="button"
          accessibilityLabel="Full Hub"
          onPress={() => {
            void openFullHub();
          }}
          style={styles.fullHub}
        >
          <Text style={styles.fullHubText}>Full Hub</Text>
        </Pressable>
      </View>
      <View style={styles.searchWrap}>
        <TextInput
          testID="simple-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search agents"
          placeholderTextColor={colors.gray600}
          style={styles.search}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      {movingName ? (
        <Text testID="simple-move-banner" style={styles.moveBanner}>
          Tap a chat to place {movingName} there
        </Text>
      ) : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {serverVisible ? (
          <ContactRow
            testID="simple-server-agent"
            contact={serverContact}
            mark
            onPress={() => {
              void openServer();
            }}
          />
        ) : null}
        {visible.map((contact) => (
          <ContactRow
            key={contact.agentId}
            testID={`simple-agent-${contact.agentId}`}
            contact={contact}
            reorderable={reorderable}
            moving={movingId === contact.agentId}
            onLongPress={
              reorderable
                ? () =>
                    setMovingId((current) => (current === contact.agentId ? null : contact.agentId))
                : undefined
            }
            onPress={() => {
              void openAgent(contact.agentId);
            }}
          />
        ))}
        {orderReady && !serverVisible && visible.length === 0 ? (
          <Text style={styles.empty}>No chats match</Text>
        ) : null}
        {!orderReady ? <ActivityIndicator color={colors.gray400} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ContactRow({
  contact,
  testID,
  mark = false,
  moving = false,
  reorderable = false,
  onPress,
  onLongPress,
}: {
  contact: SimpleContact;
  testID: string;
  mark?: boolean;
  moving?: boolean;
  reorderable?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const needsYou = contact.status === 'needs-you';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={contact.name}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.row, moving && styles.rowMoving]}
    >
      {reorderable ? (
        <Text testID={`simple-agent-drag-${contact.agentId}`} style={styles.grip}>
          ⋮⋮
        </Text>
      ) : (
        <View style={styles.gripSpacer} />
      )}
      {mark ? (
        <BrandLogo variant="mark" size="sm" />
      ) : (
        <View style={[styles.avatar, { backgroundColor: contact.color }]}>
          <Text style={styles.avatarText}>{(contact.name || '?').slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {contact.name}
        </Text>
        <Text style={[styles.preview, needsYou && styles.previewNeedsYou]} numberOfLines={1}>
          {contact.preview}
        </Text>
      </View>
      {needsYou ? <View testID={`${testID}-needs-you`} style={styles.needsDot} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  title: { color: colors.white, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.gray500, fontSize: 13, marginTop: 4 },
  fullHub: {
    alignSelf: 'flex-start',
    marginTop: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  fullHubText: { color: colors.gray200, fontSize: 13, fontWeight: '600' },
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  search: {
    color: colors.gray100,
    fontSize: 14,
    borderRadius: 12,
    backgroundColor: colors.gray900,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  moveBanner: {
    color: colors.sky300,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 8, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowMoving: { backgroundColor: colors.gray800 },
  grip: { color: colors.gray600, width: 18, textAlign: 'center', fontSize: 12 },
  gripSpacer: { width: 18 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '700' },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  preview: { color: colors.gray500, fontSize: 12, marginTop: 2 },
  previewNeedsYou: { color: colors.rose400 },
  needsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.rose400,
  },
  empty: { color: colors.gray500, textAlign: 'center', marginTop: 24 },
});
