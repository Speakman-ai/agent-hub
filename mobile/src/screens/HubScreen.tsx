import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import BrandLogo from '../components/BrandLogo';
import DashboardHomeScreen from './DashboardHomeScreen';
import DashboardScreen from './DashboardScreen';
import TodosScreen from './TodosScreen';
import CalendarScreen from './CalendarScreen';
import GmailScreen from './GmailScreen';
import SupportOverviewScreen from './SupportOverviewScreen';
import ChatScreen from './ChatScreen';
import HubChatScreen, { CountBadge } from './HubChatScreen';
import { useAccountScoped, useHubChatBadge } from '../hooks/useHubChat';
import {
  DEFAULT_HUB_PANE,
  isSummariesPaneAlias,
  parseHubPane,
  type HubWorkspacePane,
} from '@shared/utils/hub';

type HubTab = 'assistant' | HubWorkspacePane;

function parseHubTab(value: unknown): HubTab {
  if (value === 'assistant') return 'assistant';
  // Links to the removed Daily Summary tab open the Summaries channel in Chat.
  if (isSummariesPaneAlias(value)) return 'chat';
  return parseHubPane(value);
}

const TABS: { id: HubTab; label: string; icon: string }[] = [
  { id: 'assistant', label: 'Assistant', icon: 'Bot' },
  { id: 'today', label: 'Dashboard', icon: 'LayoutGrid' },
  { id: 'org', label: 'Org', icon: 'BarChart3' },
  { id: 'todos', label: 'Todos', icon: 'ListTodo' },
  { id: 'calendar', label: 'Calendar', icon: 'CalendarDays' },
  { id: 'mail', label: 'Mail', icon: 'Mail' },
  { id: 'chat', label: 'Chat', icon: 'MessageSquare' },
  { id: 'support', label: 'Support', icon: 'LifeBuoy' },
];

function HubBody({
  tab,
  navigation,
  setTab,
  chatChannelId,
  chatOpenRequest,
  onChatChannelChange,
}: {
  tab: HubTab;
  navigation: any;
  setTab: (tab: HubTab) => void;
  chatChannelId: string | null;
  chatOpenRequest: number;
  onChatChannelChange: (channelId: string | null) => void;
}) {
  const { clearHubChat } = useApp();
  switch (tab) {
    case 'assistant':
      return (
        <ChatScreen
          embedded
          onClearChat={() => {
            void clearHubChat();
          }}
        />
      );
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
    case 'calendar':
      return <CalendarScreen navigation={navigation} />;
    case 'mail':
      return <GmailScreen navigation={navigation} />;
    case 'chat':
      return (
        <HubChatScreen
          initialChannelId={chatChannelId}
          openRequest={chatOpenRequest}
          onOpenAssistant={() => setTab('assistant')}
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
 * Hub — mobile peer of the web Hub page. One drawer entry; assistant +
 * Dashboard / Org / Todos / Calendar / Mail / Chat / Support live as tabs
 * here.
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
  const [tab, setTab] = useState<HubTab>(initial);
  const chatBadge = useHubChatBadge();
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

  const openChatChannel = useCallback(
    (channelId: string) => {
      setTab('chat');
      setChatChannelId(channelId);
      setChatOpenRequest((n) => n + 1);
    },
    [setChatChannelId],
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
      >
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <TouchableOpacity
              key={item.id}
              testID={`hub-tab-${item.id}`}
              onPress={() => setTab(item.id)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <HubIcon
                name={item.icon as any}
                size={13}
                color={active ? colors.white : colors.gray400}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
              {item.id === 'chat' && chatBadge > 0 ? (
                <CountBadge count={chatBadge} testID="hub-tab-chat-badge" />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View style={styles.body}>
        <HubBody
          tab={tab}
          navigation={navigation}
          setTab={setTab}
          chatChannelId={chatChannelId}
          chatOpenRequest={chatOpenRequest}
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
  tabs: { paddingHorizontal: 12, paddingBottom: 8, gap: 6, flexDirection: 'row' },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  tabActive: { backgroundColor: colors.gray800 },
  tabLabel: { color: colors.gray400, fontSize: 12, fontWeight: '500' },
  tabLabelActive: { color: colors.white },
  body: { flex: 1, minHeight: 0 },
});
