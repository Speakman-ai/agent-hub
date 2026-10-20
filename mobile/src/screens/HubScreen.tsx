import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import BrandLogo from '../components/BrandLogo';
import DashboardHomeScreen from './DashboardHomeScreen';
import DashboardScreen from './DashboardScreen';
import TodosScreen from './TodosScreen';
import RemindersScreen from './RemindersScreen';
import CalendarScreen from './CalendarScreen';
import GmailScreen from './GmailScreen';
import SupportOverviewScreen from './SupportOverviewScreen';
import HubChatScreen from './HubChatScreen';
import { useAccountScoped } from '../hooks/useHubChat';
import {
  DEFAULT_HUB_PANE,
  isSummariesPaneAlias,
  parseHubPane,
  type HubWorkspacePane,
} from '@shared/utils/hub';

function parseHubTab(value: unknown): HubWorkspacePane {
  // The assistant and the old Daily Summary tab both open inside Chat.
  if (value === 'assistant' || isSummariesPaneAlias(value)) return 'chat';
  return parseHubPane(value);
}

function HubBody({
  tab,
  navigation,
  setTab,
  chatChannelId,
  chatOpenRequest,
  initialAssistant,
  onChatChannelChange,
}: {
  tab: HubWorkspacePane;
  navigation: any;
  setTab: (tab: HubWorkspacePane) => void;
  chatChannelId: string | null;
  chatOpenRequest: number;
  initialAssistant: boolean;
  onChatChannelChange: (channelId: string | null) => void;
}) {
  switch (tab) {
    case 'today':
      return (
        <DashboardHomeScreen
          embedded
          navigation={{
            ...navigation,
            navigate: (name: string, params?: any) => {
              if (name === 'Todos') {
                setTab('todos');
                return;
              }
              if (name === 'Calendar') {
                setTab('calendar');
                return;
              }
              if (name === 'Gmail') {
                setTab('mail');
                return;
              }
              navigation.navigate(name, params);
            },
          }}
        />
      );
    case 'org':
      return <DashboardScreen />;
    case 'todos':
      return <TodosScreen navigation={navigation} />;
    case 'reminders':
      return <RemindersScreen navigation={navigation} />;
    case 'calendar':
      return <CalendarScreen navigation={navigation} />;
    case 'mail':
      return <GmailScreen navigation={navigation} />;
    case 'chat':
      return (
        <HubChatScreen
          initialChannelId={chatChannelId}
          openRequest={chatOpenRequest}
          initialAssistant={initialAssistant}
          onChannelChange={onChatChannelChange}
          navigation={navigation}
        />
      );
    case 'support':
      return <SupportOverviewScreen />;
    default: {
      const _never: never = tab;
      return _never;
    }
  }
}

/**
 * Hub — mobile peer of the web Hub page. The drawer picks the pane. The
 * assistant opens inside Chat.
 */
export default function HubScreen({ navigation, route }: any) {
  const sidebar = useContext(SidebarContext);
  const {
    setActiveAgentId,
    setActiveSessionId,
    setSessionEngine,
    setSessionModel,
    setHubSessionId,
    setHubFocused,
  } = useApp();
  const initial = parseHubTab(route?.params?.tab || route?.params?.pane || DEFAULT_HUB_PANE);
  const [tab, setTab] = useState<HubWorkspacePane>(initial);
  // A push tap or link that names a channel opens it, even when it is the
  // channel already requested (the counter re-fires the open).
  // The retained channel belongs to the account it was opened under, so a
  // switch while the Chat tab is closed cannot reopen it under the next one.
  const [chatChannelId, setChatChannelId] = useAccountScoped<string>(
    typeof route?.params?.channelId === 'string' ? route.params.channelId : null,
  );
  const [chatOpenRequest, setChatOpenRequest] = useState(0);

  // Mark the Hub as focused so the sessions loader won't retarget the active
  // session to a project row while the assistant tab is open.
  useFocusEffect(
    useCallback(() => {
      setHubFocused(true);
      return () => setHubFocused(false);
    }, [setHubFocused]),
  );

  useEffect(() => {
    let cancelled = false;
    const req = api.getHubSession();
    req
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
        // Hub assistant unavailable; leave hubSessionId null so the embedded
        // composer stays locked instead of sending into a project session.
        if (!cancelled) setHubSessionId(null);
      });
    return () => {
      cancelled = true;
    };
    // Fetch once per Hub screen mount — NOT on tab switches. Re-running on `tab`
    // re-stamped agent/session/engine/model and could clobber an in-flight
    // composer model persist when switching Dashboard→Org.
  }, [setActiveAgentId, setActiveSessionId, setSessionEngine, setSessionModel, setHubSessionId]);

  useEffect(() => {
    if (route?.params?.pane) setTab(parseHubTab(route.params.pane));
    if (route?.params?.tab) setTab(parseHubTab(route.params.tab));
  }, [route?.params?.pane, route?.params?.tab]);

  const onChatChannelChange = setChatChannelId;

  // Pane changes made inside the Hub (Dashboard shortcuts, channel opens)
  // must also land in the route params. The drawer navigates with
  // `{ pane }`, and navigating to the current pane is a no-op param update,
  // so a stale route pane would keep the drawer from switching back.
  const selectPane = useCallback(
    (next: HubWorkspacePane) => {
      setTab(next);
      navigation?.setParams?.({ pane: next, tab: undefined });
    },
    [navigation],
  );

  const openChatChannel = useCallback(
    (channelId: string) => {
      selectPane('chat');
      setChatChannelId(channelId);
      setChatOpenRequest((n) => n + 1);
    },
    [selectPane, setChatChannelId],
  );

  useEffect(() => {
    const channelId = route?.params?.channelId;
    if (typeof channelId !== 'string' || !channelId) return;
    openChatChannel(channelId);
    // Consume the param so returning to Hub later does not reopen it.
    navigation?.setParams?.({ channelId: undefined });
  }, [route?.params?.channelId, navigation, openChatChannel]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const summariesLink =
    isSummariesPaneAlias(route?.params?.tab) || isSummariesPaneAlias(route?.params?.pane);
  useEffect(() => {
    if (!summariesLink) return;
    navigation?.setParams?.({ tab: 'chat', pane: undefined });
    api.hubChat
      .openSummaryChannel()
      .then((res: any) => {
        const id = res?.channel?.id;
        if (mountedRef.current && typeof id === 'string' && id) openChatChannel(id);
      })
      .catch(() => {
        // The Chat tab is already open; it falls back to its usual channel.
      });
  }, [summariesLink, navigation, openChatChannel]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={sidebar?.toggleSidebar}
          style={styles.menuButton}
          accessibilityLabel="Open menu"
        >
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <BrandLogo size="sm" />
      </View>
      <View style={styles.body}>
        <HubBody
          tab={tab}
          navigation={navigation}
          setTab={selectPane}
          chatChannelId={chatChannelId}
          chatOpenRequest={chatOpenRequest}
          initialAssistant={
            route?.params?.tab === 'assistant' || route?.params?.pane === 'assistant'
          }
          onChatChannelChange={onChatChannelChange}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuButton: { padding: 6 },
  menuIcon: { color: colors.gray300, fontSize: 22 },
  body: { flex: 1, minHeight: 0 },
});
