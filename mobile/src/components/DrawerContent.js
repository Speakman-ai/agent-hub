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
import { api } from '../utils/api';
import { getOrgs, getActiveOrg } from '../utils/orgs';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import humanCron from '../utils/humanCron';

export default function DrawerContent({ navigation }) {
  const {
    agents,
    projects,
    activeAgentId,
    setActiveAgentId,
    sessions,
    activeSessionId,
    setActiveSessionId,
    handleNewSession,
    handleDeleteSession,
    handleSwitchOrg,
    rooms,
    activeRoomId,
    setActiveRoomId,
    refreshRooms,
    refreshProjects,
    refreshAgents,
    cronSessions,
  } = useApp();

  const [collapsedAgents, setCollapsedAgents] = useState({});
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [showOrgPicker, setShowOrgPicker] = useState(false);

  const orgState = getOrgs();
  const orgs = orgState?.orgs || [];
  const activeOrg = getActiveOrg();

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

  const handleCronSessionSelect = (sessionId) => {
    setActiveSessionId(sessionId);
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };

  // Agents that belong to a known project
  const projectAgentIds = new Set();
  projects.forEach((p) => {
    agents.forEach((a) => {
      if (a.projectId === p.id) projectAgentIds.add(a.id);
    });
  });
  const orphanAgents = agents.filter((a) => !projectAgentIds.has(a.id) && a.active !== false);

  const renderAgentRow = (agent) => (
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
              {collapsedAgents[agent.id] ? '\u25B8' : '\u25BE'}
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
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Org Switcher Header */}
      <TouchableOpacity
        style={styles.header}
        onPress={() => setShowOrgPicker(!showOrgPicker)}
      >
        <View style={[styles.orgDot, { backgroundColor: activeOrg?.color || '#6366f1' }]} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {activeOrg?.name || 'Agent Hub'}
        </Text>
        <Text style={styles.chevron}>{showOrgPicker ? '\u25B4' : '\u25BE'}</Text>
      </TouchableOpacity>

      {showOrgPicker && (
        <View style={styles.orgDropdown}>
          {orgs.map((org) => (
            <TouchableOpacity
              key={org.id}
              style={[styles.orgItem, org.id === activeOrg?.id && styles.orgItemActive]}
              onPress={async () => {
                if (org.id !== activeOrg?.id) {
                  await handleSwitchOrg(org.id);
                }
                setShowOrgPicker(false);
              }}
            >
              <View style={[styles.orgItemDot, { backgroundColor: org.color }]} />
              <Text style={styles.orgItemName} numberOfLines={1}>{org.name}</Text>
              <Text style={styles.orgMode}>{'\u2601'}</Text>
              {org.id === activeOrg?.id && <Text style={styles.orgCheck}>{'\u2713'}</Text>}
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.orgManage}
            onPress={() => {
              setShowOrgPicker(false);
              navigation.navigate('Settings');
              navigation.closeDrawer();
            }}
          >
            <Text style={styles.orgManageText}>Manage Organizations</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Agents grouped by Project */}
      <ScrollView style={styles.agentList}>
        {cronSessions.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.sectionLabel}>SCHEDULED TASKS</Text>
            {cronSessions.map((cs) => (
              <TouchableOpacity
                key={cs.id}
                style={[
                  styles.agentItem,
                  activeSessionId === cs.id && styles.agentItemActive,
                ]}
                onPress={() => handleCronSessionSelect(cs.id)}
              >
                <View style={styles.agentInfo}>
                  <Text
                    style={[
                      styles.agentName,
                      activeSessionId === cs.id && styles.agentNameActive,
                    ]}
                    numberOfLines={1}
                  >
                    {cs.cron_name || cs.name}
                  </Text>
                  <Text style={styles.cronScheduleText}>
                    {humanCron(cs.cron_schedule)}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {projects.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>PROJECTS</Text>
            {projects.map((project, index) => {
              const projectAgents = agents.filter(
                (a) => a.projectId === project.id && a.active !== false
              );
              if (projectAgents.length === 0) return null;
              const isCollapsed = collapsedProjects[project.id];

              return (
                <View key={project.id}>
                  {index > 0 && <View style={styles.projectDivider} />}
                  <View style={styles.projectHeaderRow}>
                    <TouchableOpacity
                      style={[styles.projectHeader, { flex: 1 }]}
                      onPress={() => {
                        if (projectAgents.length === 1) {
                          handleAgentSelect(projectAgents[0].id);
                        } else {
                          setCollapsedProjects((prev) => ({
                            ...prev,
                            [project.id]: !prev[project.id],
                          }));
                        }
                      }}
                      onLongPress={() => {
                        Alert.alert(
                          'Delete Project',
                          `Delete "${project.name}" and all its agents, sessions, board, and wiki data? This cannot be undone.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: async () => {
                                try {
                                  await api.deleteProject(project.id);
                                  refreshProjects();
                                  refreshAgents();
                                } catch (err) {
                                  Alert.alert('Error', 'Failed to delete project');
                                }
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <View
                        style={[styles.projectDot, { backgroundColor: project.color || '#6366f1' }]}
                      />
                      <Text style={styles.projectName} numberOfLines={1}>
                        {project.name}
                      </Text>
                      {projectAgents.length > 1 && (
                        <Text style={styles.collapseIcon}>
                          {isCollapsed ? '\u25B8' : '\u25BE'}
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.boardButton}
                      onPress={() => {
                        navigation.navigate('Kanban', { projectId: project.id, project });
                        navigation.closeDrawer();
                      }}
                    >
                      <Text style={styles.boardButtonText}>{'\u25A6'} Board</Text>
                    </TouchableOpacity>
                    {project.githubRepo ? (
                      <TouchableOpacity
                        style={styles.boardButton}
                        onPress={() => {
                          navigation.navigate('PullRequests', { projectId: project.id, project });
                          navigation.closeDrawer();
                        }}
                      >
                        <Text style={styles.boardButtonText}>{'\u2387'} PRs</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  {!isCollapsed && projectAgents.map((agent) => renderAgentRow(agent))}
                </View>
              );
            })}
          </>
        )}

        {/* Agents without a project (fallback / orphans) */}
        {orphanAgents.length > 0 && (
          <View>
            <Text style={styles.sectionLabel}>
              {projects.length > 0 ? 'OTHER AGENTS' : 'AGENTS'}
            </Text>
            {orphanAgents.map((agent) => renderAgentRow(agent))}
          </View>
        )}

        {/* Conference Rooms */}
        <View style={{ marginTop: 16 }}>
          <Text style={styles.sectionLabel}>CONFERENCE ROOMS</Text>
          {rooms.map((rm) => (
            <TouchableOpacity
              key={rm.id}
              style={[styles.agentItem, activeRoomId === rm.id && styles.agentItemActive]}
              onPress={() => {
                setActiveRoomId(rm.id);
                navigation.navigate('Rooms');
                navigation.closeDrawer();
              }}
              onLongPress={() => {
                Alert.alert('Delete Room', `Delete "${rm.name}"?`, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        await api.deleteRoom(rm.id);
                        refreshRooms();
                        if (activeRoomId === rm.id) setActiveRoomId(null);
                      } catch {}
                    },
                  },
                ]);
              }}
            >
              <Text style={{ fontSize: 14 }}>{'\uD83C\uDFE2'}</Text>
              <Text style={[styles.agentName, activeRoomId === rm.id && styles.agentNameActive]} numberOfLines={1}>
                {rm.name}
              </Text>
              <View style={{ flexDirection: 'row', gap: 3 }}>
                {(rm.agents || []).slice(0, 4).map((agentRef, i) => {
                  const a = agents.find(ag => ag.id === (typeof agentRef === 'string' ? agentRef : agentRef?.id));
                  return <View key={i} style={[styles.miniDot, { backgroundColor: a?.color || colors.gray500 }]} />;
                })}
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.newSessionButton}
            onPress={() => {
              Alert.prompt?.('New Room', 'Room name:', async (name) => {
                if (!name?.trim()) return;
                try {
                  const room = await api.createRoom(name.trim());
                  refreshRooms();
                  setActiveRoomId(room.id);
                  navigation.navigate('Rooms');
                  navigation.closeDrawer();
                } catch {}
              }) || (() => {
                // Fallback for Android (no Alert.prompt)
                navigation.closeDrawer();
                // Use a simple approach - create with default name
                (async () => {
                  try {
                    const room = await api.createRoom('New Room');
                    refreshRooms();
                    setActiveRoomId(room.id);
                  } catch {}
                })();
              })();
            }}
          >
            <Text style={styles.newSessionText}>+ New Room</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Bottom Nav */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            const pid = projects?.[0]?.id;
            if (pid) navigation.navigate('Wiki', { projectId: pid });
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>Wiki</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            const pid = projects?.[0]?.id;
            if (pid) navigation.navigate('Notes', { projectId: pid });
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>Notes</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            navigation.navigate('Skills');
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>Skills</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => {
            navigation.navigate('Settings');
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.navButtonText}>Settings</Text>
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
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.white,
  },
  orgDot: {
    width: 20,
    height: 20,
    borderRadius: 6,
  },
  chevron: {
    color: colors.gray500,
    fontSize: 12,
  },
  orgDropdown: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    overflow: 'hidden',
  },
  orgItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  orgItemActive: {
    backgroundColor: colors.gray700,
  },
  orgItemDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
  },
  orgItemName: {
    flex: 1,
    fontSize: 13,
    color: colors.gray300,
  },
  orgMode: {
    fontSize: 12,
  },
  orgCheck: {
    color: colors.emerald400,
    fontSize: 14,
    fontWeight: 'bold',
  },
  orgManage: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  orgManageText: {
    fontSize: 12,
    color: colors.gray500,
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
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  projectDot: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  projectName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.gray300,
  },
  projectHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  boardButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    marginRight: 8,
  },
  boardButtonText: {
    fontSize: 11,
    color: colors.gray500,
    fontWeight: '500',
  },
  projectDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    marginHorizontal: 8,
    marginVertical: 4,
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
  miniDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
  cronScheduleText: {
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
