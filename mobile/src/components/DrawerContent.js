import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';

export default function DrawerContent({ navigation }) {
  const {
    agents,
    activeAgentId,
    setActiveAgentId,
    sessions,
    activeSessionId,
    setActiveSessionId,
    handleNewSession,
    handleDeleteSession,
  } = useApp();

  const [collapsedAgents, setCollapsedAgents] = useState({});

  const toggleCollapse = (agentId) => {
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const isRecent = (dateStr) => {
    if (!dateStr) return false;
    const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'Z');
    return Date.now() - d.getTime() < 30 * 60 * 1000;
  };

  const handleAgentSelect = (agentId) => {
    setActiveAgentId(agentId);
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };

  const handleSessionSelect = (sessionId) => {
    setActiveSessionId(sessionId);
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };

  const confirmDeleteSession = (sessionId) => {
    Alert.alert('Delete Session', 'Are you sure you want to delete this session?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => handleDeleteSession(sessionId),
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <TouchableOpacity
        style={styles.header}
        onPress={() => {
          navigation.navigate('Chat');
          navigation.closeDrawer();
        }}
      >
        <Text style={styles.headerEmoji}>🤖</Text>
        <Text style={styles.headerTitle}>Agent Hub</Text>
      </TouchableOpacity>

      {/* Agents List */}
      <ScrollView style={styles.agentList}>
        <Text style={styles.sectionLabel}>AGENTS</Text>
        {agents.map((agent) => (
          <View key={agent.id}>
            <TouchableOpacity
              style={[
                styles.agentItem,
                activeAgentId === agent.id && styles.agentItemActive,
              ]}
              onPress={() => handleAgentSelect(agent.id)}
            >
              <View style={styles.agentDotContainer}>
                <View style={[styles.agentDot, { backgroundColor: agent.color }]} />
                {isRecent(agent.lastActivity) && (
                  <View style={styles.activityIndicator} />
                )}
              </View>
              <View style={styles.agentInfo}>
                <Text
                  style={[
                    styles.agentName,
                    activeAgentId === agent.id && styles.agentNameActive,
                  ]}
                  numberOfLines={1}
                >
                  {agent.name}
                </Text>
                {agent.lastMessage && (
                  <Text style={styles.agentLastMessage} numberOfLines={1}>
                    {agent.lastMessage.content}
                  </Text>
                )}
              </View>
              {activeAgentId === agent.id && (
                <TouchableOpacity
                  onPress={() => toggleCollapse(agent.id)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text style={styles.collapseIcon}>
                    {collapsedAgents[agent.id] ? '▸' : '▾'}
                  </Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>

            {/* Sessions */}
            {activeAgentId === agent.id && !collapsedAgents[agent.id] && (
              <View style={styles.sessionsContainer}>
                {sessions.map((session) => (
                  <TouchableOpacity
                    key={session.id}
                    style={[
                      styles.sessionItem,
                      activeSessionId === session.id && styles.sessionItemActive,
                    ]}
                    onPress={() => handleSessionSelect(session.id)}
                    onLongPress={() => confirmDeleteSession(session.id)}
                  >
                    <Text
                      style={[
                        styles.sessionName,
                        activeSessionId === session.id && styles.sessionNameActive,
                      ]}
                      numberOfLines={1}
                    >
                      {session.name}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={styles.newSessionButton}
                  onPress={async () => {
                    await handleNewSession();
                    navigation.navigate('Chat');
                    navigation.closeDrawer();
                  }}
                >
                  <Text style={styles.newSessionText}>+ New Session</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Bottom Nav */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            navigation.navigate('Skills');
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>📚 Skills</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            navigation.navigate('Settings');
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>⚙️ Settings</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray900,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerEmoji: {
    fontSize: 24,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.white,
  },
  agentList: {
    flex: 1,
    padding: 12,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 1,
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  agentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 2,
  },
  agentItemActive: {
    backgroundColor: colors.gray800,
  },
  agentDotContainer: {
    position: 'relative',
  },
  agentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  activityIndicator: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.emerald500,
    borderWidth: 1.5,
    borderColor: colors.gray900,
  },
  agentInfo: {
    flex: 1,
    minWidth: 0,
  },
  agentName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  agentNameActive: {
    color: colors.white,
  },
  agentLastMessage: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
  },
  collapseIcon: {
    color: colors.gray500,
    fontSize: 12,
    paddingHorizontal: 4,
  },
  sessionsContainer: {
    marginLeft: 24,
    marginBottom: 8,
  },
  sessionItem: {
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 6,
    marginBottom: 2,
  },
  sessionItemActive: {
    backgroundColor: colors.gray800,
  },
  sessionName: {
    fontSize: 12,
    color: colors.gray500,
  },
  sessionNameActive: {
    color: colors.white,
  },
  newSessionButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  newSessionText: {
    fontSize: 12,
    color: colors.gray600,
  },
  bottomNav: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    padding: 12,
    gap: 4,
  },
  navButton: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
  },
  navButtonText: {
    fontSize: 14,
    color: colors.gray400,
  },
});
