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
import { relativeTime, daysUntilPurge } from '../utils/time';
import humanCron from '../utils/humanCron';
import { isWorkflowProject } from '../utils/project-mode';

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
    archivedSessions,
    handleRestoreSession,
    restoringSessionIds,
    handleSwitchOrg,
    refreshProjects,
    refreshAgents,
    cronSessions,
    unreadThreadCounts,
    reloadMessages,
  } = useApp();

  const [collapsedAgents, setCollapsedAgents] = useState({});
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [archivedExpanded, setArchivedExpanded] = useState(false);
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
    // If the user taps the already-active session, `setActiveSessionId` is
    // a no-op and React Navigation's focus event won't fire either — so the
    // chat wouldn't refresh at all. Explicitly reload so every drawer tap
    // pulls the latest message history from the server.
    if (sessionId === activeSessionId) {
      reloadMessages();
    } else {
      setActiveSessionId(sessionId);
    }
    navigation.navigate('Chat');
    navigation.closeDrawer();
  };

  const confirmDeleteSession = (sessionId) => {
    // The confirmation copy already explains the 7-day window, so the
    // archive action completes silently — no second "Archived" modal that
    // would block interaction. The row appears in the Archived drawer
    // section immediately and failures surface via an error Alert from
    // handleDeleteSession itself.
    Alert.alert(
      'Delete Session',
      'Archive this session? You can restore it within 7 days from the Archived section.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            // Swallow the rejection — handleDeleteSession surfaces its own
            // alert on failure, so we just need to avoid an unhandled promise.
            handleDeleteSession(sessionId).catch(() => {});
          },
        },
      ],
    );
  };

  // Same reload-on-re-tap logic as handleSessionSelect — if the user taps the
  // already-active cron session, explicitly reload since neither setState nor
  // navigation focus will trigger a refresh.
  const handleCronSessionSelect = (sessionId) => {
    if (sessionId === activeSessionId) {
      reloadMessages();
    } else {
      setActiveSessionId(sessionId);
    }
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
          {/* Reviewer agents are GitHub-webhook spawned — hide manual
              "+ New Session" so the user can't kick a 403 from the
              POST /api/agents/:id/sessions gate. */}
          {agent.role !== 'reviewer' && (
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
          )}

          {/* Archived (soft-deleted within 7 days) — collapsed by default so
              the drawer stays quiet when nothing is pending recovery. Mirror
              of the web sidebar's Archived section in Sidebar.jsx. */}
          {archivedSessions && archivedSessions.length > 0 && (
            <View style={styles.archivedSection} testID="archived-sessions-section">
              <TouchableOpacity
                onPress={() => setArchivedExpanded((v) => !v)}
                style={styles.archivedHeader}
              >
                <Text style={styles.archivedHeaderText}>
                  Archived ({archivedSessions.length})
                </Text>
                <Text style={styles.archivedChevron}>
                  {archivedExpanded ? '\u25BE' : '\u25B8'}
                </Text>
              </TouchableOpacity>
              {archivedExpanded && (
                <View testID="archived-sessions-list">
                  {archivedSessions.map((a) => {
                    const purge = daysUntilPurge(a.deleted_at);
                    // AppContext always passes a Set; optional chaining keeps
                    // this safe if a test mounts DrawerContent without it.
                    const isRestoring = restoringSessionIds.has(a.id);
                    const urgent = purge && purge.daysLeft <= 1;
                    return (
                      <View key={a.id} style={styles.archivedRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.archivedName} numberOfLines={1}>
                            {a.name}
                          </Text>
                          {purge && (
                            <Text
                              style={[
                                styles.archivedPurge,
                                urgent && styles.archivedPurgeUrgent,
                              ]}
                            >
                              {purge.label}
                            </Text>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => handleRestoreSession(a.id)}
                          disabled={isRestoring}
                          style={[
                            styles.restoreButton,
                            isRestoring && styles.restoreButtonDisabled,
                          ]}
                        >
                          <Text style={styles.restoreButtonText}>
                            {isRestoring ? '…' : 'Restore'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          )}
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
        {/* Org-scoped Dashboard — sits above the project list. */}
        <TouchableOpacity
          style={styles.dashboardItem}
          onPress={() => {
            navigation.navigate('Dashboard');
            navigation.closeDrawer();
          }}
        >
          <Text style={styles.dashboardIcon}>{'\u25B0'}</Text>
          <Text style={styles.dashboardText}>Dashboard</Text>
        </TouchableOpacity>

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
                        {isWorkflowProject(project) ? (
                          <Text style={styles.workflowTag}> Wf</Text>
                        ) : null}
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
                    <TouchableOpacity
                      style={styles.boardButton}
                      onPress={() => {
                        navigation.navigate('Threads', { projectId: project.id, project });
                        navigation.closeDrawer();
                      }}
                    >
                      <View style={styles.threadsButtonContent}>
                        <Text style={styles.boardButtonText}>{'\u2630'} Threads</Text>
                        {unreadThreadCounts?.[project.id] > 0 && (
                          <View style={styles.unreadBadge}>
                            <Text style={styles.unreadBadgeText}>
                              {unreadThreadCounts[project.id] > 99
                                ? '99+'
                                : unreadThreadCounts[project.id]}
                            </Text>
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>
                    {project.githubRepo && !isWorkflowProject(project) ? (
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
  dashboardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 16,
    backgroundColor: colors.gray800,
  },
  dashboardIcon: {
    color: colors.blue400,
    fontSize: 14,
  },
  dashboardText: {
    color: colors.gray200,
    fontSize: 14,
    fontWeight: '500',
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
  workflowTag: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.amber400,
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
  threadsButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  unreadBadge: {
    backgroundColor: colors.rose400,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: {
    color: colors.white,
    fontSize: 9,
    fontWeight: '700',
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
  archivedSection: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  archivedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  archivedHeaderText: {
    flex: 1,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.gray600,
  },
  archivedChevron: {
    color: colors.gray600,
    fontSize: 12,
  },
  archivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  archivedName: {
    fontSize: 12,
    color: colors.gray500,
  },
  archivedPurge: {
    fontSize: 10,
    color: colors.gray600,
    marginTop: 1,
  },
  archivedPurgeUrgent: {
    color: '#fbbf24', // amber-400 — mirrors web sidebar's urgency signal
  },
  restoreButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    marginLeft: 8,
  },
  restoreButtonDisabled: {
    opacity: 0.4,
  },
  restoreButtonText: {
    fontSize: 11,
    color: colors.gray300,
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
