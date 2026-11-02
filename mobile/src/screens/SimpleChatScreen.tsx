import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import BrandLogo from '../components/BrandLogo';
import ChatScreen from './ChatScreen';
import { serverAgentDisplayName, useServerAgentSettings } from '../utils/serverAgentInstance';
import { simpleShellMustLeaveFor, writeShellMode } from '../utils/simpleShell';

/**
 * One simple chat. Back returns to the contact list. The transcript is the
 * same chat screen as the full app, with the build chrome hidden.
 */
export default function SimpleChatScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const focused = useIsFocused();
  const kind = route.params?.kind === 'server' ? 'server' : 'agent';
  const agentId = typeof route.params?.agentId === 'string' ? route.params.agentId : '';
  const routeSessionId = typeof route.params?.sessionId === 'string' ? route.params.sessionId : '';
  const {
    agents,
    sessions,
    activeAgentId,
    activeSessionId,
    clearHubChat,
    handleOpenHandoffSession,
    setActiveAgentId,
    setActiveSessionId,
    setHubFocused,
    setHubSessionId,
    setSessionEngine,
    setSessionModel,
  } = useApp();
  const settings = useServerAgentSettings();
  const isServer = kind === 'server';
  const agent = (agents || []).find((row: any) => row.id === agentId);
  const title = isServer ? serverAgentDisplayName(settings) : agent?.name || 'Chat';

  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  // True once this focus has seen its own chat active. Until then a stale
  // selection from another screen is expected and must not trip the guard.
  const boundRef = useRef(false);

  // This screen owns which chat it shows and binds it on every focus, not
  // only on mount: it stays mounted under Chat when a transcript link opens
  // another session, and must take its own chat back when the user returns.
  // Project chats carry their consult session in the route; the Server Agent
  // asks for the Hub session, and a response that lands after blur is
  // dropped so it cannot override a selection made elsewhere.
  useFocusEffect(
    useCallback(() => {
      boundRef.current = false;
      void writeShellMode('simple');
      if (!isServer) {
        if (!agentId || !routeSessionId) return undefined;
        if (activeAgentIdRef.current !== agentId) {
          handleOpenHandoffSession(agentId, routeSessionId);
        } else {
          setActiveSessionId(routeSessionId);
        }
        return undefined;
      }
      let cancelled = false;
      setHubFocused(true);
      api
        .getHubSession()
        .then((body: any) => {
          if (cancelled) return;
          if (body?.agent?.id) setActiveAgentId(body.agent.id);
          if (body?.session?.id) {
            setHubSessionId(body.session.id);
            setActiveSessionId(body.session.id);
          }
          if (body?.session?.engine) setSessionEngine(body.session.engine);
          if (body?.session?.model) setSessionModel(body.session.model);
        })
        .catch(() => {
          if (!cancelled) setHubSessionId(null);
        });
      return () => {
        cancelled = true;
        setHubFocused(false);
      };
    }, [
      isServer,
      agentId,
      routeSessionId,
      handleOpenHandoffSession,
      setActiveAgentId,
      setActiveSessionId,
      setHubFocused,
      setHubSessionId,
      setSessionEngine,
      setSessionModel,
    ]),
  );

  // The simple chat only shows consult chats. A session link from the
  // transcript (a dispatched build, a fork) opens in the full chat screen,
  // where its build controls are visible.
  const openSessionInFullChat = useCallback(
    (targetAgentId: string, targetSessionId: string) => {
      if (!targetAgentId || !targetSessionId) return;
      void writeShellMode('hub');
      handleOpenHandoffSession(targetAgentId, targetSessionId);
      navigation.navigate('Chat');
    },
    [handleOpenHandoffSession, navigation],
  );

  useEffect(() => {
    if (focused && activeSessionId && activeSessionId === routeSessionId) boundRef.current = true;
  }, [focused, activeSessionId, routeSessionId]);

  // Any other way a non-consult session becomes active here once the chat is
  // bound (the loader picking the newest row) leaves the same way.
  const activeRow = (sessions || []).find((row: any) => row.id === activeSessionId);
  const mustLeave = !isServer && focused && simpleShellMustLeaveFor(activeRow);
  useEffect(() => {
    if (!mustLeave) return;
    if (routeSessionId && !boundRef.current) return;
    void writeShellMode('hub');
    navigation.navigate('Chat');
  }, [mustLeave, navigation, routeSessionId]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          testID="simple-back"
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          onPress={() => navigation.navigate('Simple')}
          style={styles.back}
        >
          <Text style={styles.backText}>Chats</Text>
        </Pressable>
        {isServer ? <BrandLogo variant="mark" size="xs" /> : null}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <ChatScreen
        embedded
        simple
        simpleServer={isServer}
        emptyHint={isServer ? undefined : `Ask ${title} anything.`}
        onOpenSession={openSessionInFullChat}
        onClearChat={
          isServer
            ? () => {
                void clearHubChat();
              }
            : undefined
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  back: { paddingVertical: 6, paddingRight: 4 },
  backText: { color: colors.blue400, fontSize: 16, fontWeight: '600' },
  title: { flex: 1, color: colors.white, fontSize: 16, fontWeight: '600' },
});
