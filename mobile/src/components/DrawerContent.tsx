import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, Platform, Pressable, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { getOrgs, getActiveOrg } from '../utils/orgs';
import { getApiBaseUrl, getWsUrl } from '../utils/config';
import { colors } from '../theme/colors';
import { relativeTime, daysUntilPurge, parseDate } from '../utils/time';
import humanCron from '@shared/utils/humanCron';
import { isWorkflowProject } from '../utils/project-mode';
import { projectLifecycleEntries, projectSettingsEntries } from '../utils/projectMenu';
import { shouldShowCalendarNav, shouldShowGmailNav } from '../utils/googleSurface';
import { deriveSessionState } from '../utils/deriveSessionState';
import SessionStateIcon from './SessionStateIcon';
import HubIcon from './HubIcon';
import BugReportButton from './BugReportButton';
export default function DrawerContent({ navigation }: any) {
    const { agents, projects, activeAgentId, setActiveAgentId, sessions, activeSessionId, setActiveSessionId, handleNewSession, handleDeleteSession, archivedSessions, handleRestoreSession, restoringSessionIds, handleSwitchOrg, refreshProjects, refreshAgents, cronSessions, activeTasks, finalizeStatusBySession, unreadThreadCounts, unreadTicketCounts, openPullCounts, securityOpenCounts, reloadMessages, connected, reconnecting, } = useApp();
    const activeAgent = agents.find((a: any) => a.id === activeAgentId) || null;
    const bugReportProjectId = activeAgent?.projectId || '';
    const [collapsedAgents, setCollapsedAgents] = useState<any>({});
    const [collapsedProjects, setCollapsedProjects] = useState<any>({});
    // Per-project "<project> Settings" submenu — collapsed by default, mirroring
    // the web sidebar (`collapsedProjectMenus[id] ?? true`).
    const [collapsedProjectMenus, setCollapsedProjectMenus] = useState<any>({});
    const [archivedExpanded, setArchivedExpanded] = useState(false);
    const [showOrgPicker, setShowOrgPicker] = useState(false);
    // Server version / git hash for the footer (matches the web sidebar footer).
    const [health, setHealth] = useState<any>(null);
    useEffect(() => {
        let cancelled = false;
        api
            .getHealth()
            .then((h: any) => {
            if (!cancelled)
                setHealth(h);
        })
            .catch(() => {
            /* footer version is best-effort — ignore failures */
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // Per-user Google connection status — gates the global Calendar drawer entry
    // (shown only when connected). Calendar is NOT a per-project surface.
    const [googleStatus, setGoogleStatus] = useState<any>(null);
    useEffect(() => {
        let cancelled = false;
        api
            .getGoogleStatus()
            .then((s: any) => {
            if (!cancelled)
                setGoogleStatus(s);
        })
            .catch(() => {
            if (!cancelled)
                setGoogleStatus({ connected: false });
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const calendarNavVisible = shouldShowCalendarNav(googleStatus);
    const gmailNavVisible = shouldShowGmailNav(googleStatus);
    const orgState = getOrgs();
    const orgs = orgState?.orgs || [];
    const activeOrg = getActiveOrg();
    const toggleCollapse = (agentId: any) => {
        setCollapsedAgents((prev: any) => ({ ...prev, [agentId]: !prev[agentId] }));
    };
    const isRecent = (dateStr: any) => {
        const d = parseDate(dateStr);
        if (!d || Number.isNaN(d.getTime()))
            return false;
        return Date.now() - d.getTime() < 30 * 60 * 1000;
    };
    const handleAgentSelect = (agentId: any) => {
        setActiveAgentId(agentId);
        navigation.navigate('Chat');
        navigation.closeDrawer();
    };
    const showConnectionInfo = () => {
        const org = getActiveOrg();
        const apiUrl = getApiBaseUrl();
        const wsUrl = getWsUrl();
        Alert.alert('Connection Info', `Org: ${org?.name || '(none)'}\n` +
            `URL: ${org?.remoteUrl || '(not set)'}\n` +
            `API: ${apiUrl || '(empty)'}\n` +
            `WS: ${wsUrl ? wsUrl.replace(/apiKey=[^&]+/, 'apiKey=***') : '(empty)'}\n` +
            `Key: ${org?.apiKey ? `${org.apiKey.slice(0, 5)}...${org.apiKey.slice(-4)}` : '(none)'}\n` +
            `Status: ${connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'}`);
    };
    const handleSessionSelect = (sessionId: any) => {
        // If the user taps the already-active session, `setActiveSessionId` is
        // a no-op and React Navigation's focus event won't fire either — so the
        // chat wouldn't refresh at all. Explicitly reload so every drawer tap
        // pulls the latest message history from the server.
        if (sessionId === activeSessionId) {
            reloadMessages();
        }
        else {
            setActiveSessionId(sessionId);
        }
        navigation.navigate('Chat');
        navigation.closeDrawer();
    };
    const confirmDeleteSession = (sessionId: any) => {
        // The confirmation copy already explains the 7-day window, so the
        // archive action completes silently — no second "Archived" modal that
        // would block interaction. The row appears in the Archived drawer
        // section immediately and failures surface via an error Alert from
        // handleDeleteSession itself.
        Alert.alert('Delete Session', 'Archive this session? You can restore it within 7 days from the Archived section.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Archive',
                style: 'destructive',
                onPress: () => {
                    // Swallow the rejection — handleDeleteSession surfaces its own
                    // alert on failure, so we just need to avoid an unhandled promise.
                    handleDeleteSession(sessionId).catch(() => { });
                },
            },
        ]);
    };
    // Same reload-on-re-tap logic as handleSessionSelect — if the user taps the
    // already-active cron session, explicitly reload since neither setState nor
    // navigation focus will trigger a refresh.
    const handleCronSessionSelect = (sessionId: any) => {
        if (sessionId === activeSessionId) {
            reloadMessages();
        }
        else {
            setActiveSessionId(sessionId);
        }
        navigation.navigate('Chat');
        navigation.closeDrawer();
    };
    // Agents that belong to a known project
    const projectAgentIds = new Set();
    projects.forEach((p: any) => {
        agents.forEach((a: any) => {
            if (a.projectId === p.id)
                projectAgentIds.add(a.id);
        });
    });
    const orphanAgents = agents.filter((a: any) => !projectAgentIds.has(a.id) && a.active !== false);
    const renderAgentRow = (agent: any) => (<View key={agent.id}>
      <TouchableOpacity style={[
            styles.agentItem,
            activeAgentId === agent.id && styles.agentItemActive,
        ]} onPress={() => handleAgentSelect(agent.id)}>
        <View style={styles.agentDotContainer}>
          <View style={[styles.agentDot, { backgroundColor: agent.color }]}/>
          {isRecent(agent.lastActivity) && (<View style={styles.activityIndicator}/>)}
        </View>
        <View style={styles.agentInfo}>
          <Text style={[
            styles.agentName,
            activeAgentId === agent.id && styles.agentNameActive,
        ]} numberOfLines={1}>
            {agent.name}
          </Text>
          {agent.lastMessage && (<Text style={styles.agentLastMessage} numberOfLines={1}>
              {agent.lastMessage.content}
            </Text>)}
        </View>
        {activeAgentId === agent.id && (<TouchableOpacity onPress={() => toggleCollapse(agent.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.collapseIcon}>
              {collapsedAgents[agent.id] ? '\u25B8' : '\u25BE'}
            </Text>
          </TouchableOpacity>)}
      </TouchableOpacity>

      {/* Sessions */}
      {activeAgentId === agent.id && !collapsedAgents[agent.id] && (<View style={styles.sessionsContainer}>
          {sessions.map((session: any) => (<TouchableOpacity key={session.id} style={[
                    styles.sessionItem,
                    activeSessionId === session.id && styles.sessionItemActive,
                ]} onPress={() => handleSessionSelect(session.id)} onLongPress={() => confirmDeleteSession(session.id)}>
              <SessionStateIcon state={deriveSessionState(session, {
                    activeTaskSessionIds: activeTasks,
                    finalizeStatusBySession,
                })} testID={`session-state-icon-${session.id}`}/>
              <Text style={[
                    styles.sessionName,
                    activeSessionId === session.id && styles.sessionNameActive,
                ]} numberOfLines={1}>
                {session.name}
              </Text>
            </TouchableOpacity>))}
          {/* Reviewer agents are spawned only by the Finalize review phase —
                  hide manual "+ New Session" so the user can't kick a 403 from
                  the POST /api/agents/:id/sessions gate. */}
          {agent.role !== 'reviewer' && (<TouchableOpacity style={styles.newSessionButton} onPress={async () => {
                    await handleNewSession();
                    navigation.navigate('Chat');
                    navigation.closeDrawer();
                }}>
              <Text style={styles.newSessionText}>+ New Session</Text>
            </TouchableOpacity>)}

          {/* Archived (soft-deleted within 7 days) — collapsed by default so
                  the drawer stays quiet when nothing is pending recovery. Mirror
                  of the web sidebar's Archived section in Sidebar.jsx. */}
          {archivedSessions && archivedSessions.length > 0 && (<View style={styles.archivedSection} testID="archived-sessions-section">
              <TouchableOpacity onPress={() => setArchivedExpanded((v: any) => !v)} style={styles.archivedHeader}>
                <Text style={styles.archivedHeaderText}>
                  Archived ({archivedSessions.length})
                </Text>
                <Text style={styles.archivedChevron}>
                  {archivedExpanded ? '\u25BE' : '\u25B8'}
                </Text>
              </TouchableOpacity>
              {archivedExpanded && (<View testID="archived-sessions-list">
                  {archivedSessions.map((a: any) => {
                        const purge = daysUntilPurge(a.deleted_at);
                        // AppContext always passes a Set; optional chaining keeps
                        // this safe if a test mounts DrawerContent without it.
                        const isRestoring = restoringSessionIds.has(a.id);
                        const urgent = purge && purge.daysLeft <= 1;
                        return (<View key={a.id} style={styles.archivedRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.archivedName} numberOfLines={1}>
                            {a.name}
                          </Text>
                          {purge && (<Text style={[
                                    styles.archivedPurge,
                                    urgent && styles.archivedPurgeUrgent,
                                ]}>
                              {purge.label}
                            </Text>)}
                        </View>
                        <TouchableOpacity onPress={() => handleRestoreSession(a.id)} disabled={isRestoring} style={[
                                styles.restoreButton,
                                isRestoring && styles.restoreButtonDisabled,
                            ]}>
                          <Text style={styles.restoreButtonText}>
                            {isRestoring ? '…' : 'Restore'}
                          </Text>
                        </TouchableOpacity>
                      </View>);
                    })}
                </View>)}
            </View>)}
        </View>)}
    </View>);
    const renderMenuItem = (project: any, entry: any) => (<TouchableOpacity key={entry.key} style={styles.projectMenuItem} onPress={() => {
            navigation.navigate(entry.screen, {
                projectId: project.id,
                project,
            });
            navigation.closeDrawer();
        }}>
      <HubIcon name={entry.icon} size={14} color={colors.gray500} style={styles.projectMenuItemIcon}/>
      <Text style={styles.projectMenuItemText} numberOfLines={1}>
        {entry.label}
      </Text>
      {entry.key === 'threads' && unreadThreadCounts?.[project.id] > 0 && (<View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {unreadThreadCounts[project.id] > 99 ? '99+' : unreadThreadCounts[project.id]}
          </Text>
        </View>)}
      {entry.key === 'support' && unreadTicketCounts?.[project.id] > 0 && (<View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {unreadTicketCounts[project.id] > 99 ? '99+' : unreadTicketCounts[project.id]}
          </Text>
        </View>)}
      {entry.key === 'pulls' && openPullCounts?.[project.id] > 0 && (<View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {openPullCounts[project.id] > 99 ? '99+' : openPullCounts[project.id]}
          </Text>
        </View>)}
      {entry.key === 'security' &&
            (() => {
                const counts = securityOpenCounts?.[project.id];
                const criticalHigh = counts ? (counts.critical || 0) + (counts.high || 0) : 0;
                if (criticalHigh <= 0)
                    return null;
                return (<View style={[styles.unreadBadge, styles.securityBadge]}>
              <Text style={styles.unreadBadgeText}>
                {criticalHigh > 99 ? '99+' : criticalHigh}
              </Text>
            </View>);
            })()}
    </TouchableOpacity>);
    // Lifecycle nav (always visible) + collapsed "<project> Settings" submenu.
    const renderProjectMenu = (project: any) => {
        const isMenuCollapsed = collapsedProjectMenus[project.id] ?? true;
        const lifecycle = projectLifecycleEntries(project);
        const settings = projectSettingsEntries(project);
        return (<View style={styles.projectMenu}>
        <View style={styles.projectMenuItems}>
          {lifecycle.map((entry: any) => renderMenuItem(project, entry))}
        </View>

        <TouchableOpacity style={styles.projectMenuToggle} onPress={() => setCollapsedProjectMenus((prev: any) => ({
                ...prev,
                [project.id]: !(prev[project.id] ?? true),
            }))}>
          <HubIcon name={isMenuCollapsed ? 'ChevronRight' : 'ChevronDown'} size={14} color={colors.gray500} style={styles.projectMenuChevron}/>
          <HubIcon name="Settings" size={14} color={colors.gray500} style={styles.projectMenuGear}/>
          <Text style={styles.projectMenuToggleText} numberOfLines={1}>
            {project.name} Settings
          </Text>
        </TouchableOpacity>

        {!isMenuCollapsed && (<View style={styles.projectMenuItems}>
            {settings.map((entry: any) => renderMenuItem(project, entry))}
          </View>)}
      </View>);
    };
    return (<SafeAreaView style={styles.container}>
      {/* Org Switcher Header */}
      <TouchableOpacity style={styles.header} onPress={() => setShowOrgPicker(!showOrgPicker)}>
        <View style={[styles.orgDot, { backgroundColor: activeOrg?.color || '#6366f1' }]}/>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {activeOrg?.name || 'Agent Hub'}
        </Text>
        <Text style={styles.chevron}>{showOrgPicker ? '\u25B4' : '\u25BE'}</Text>
      </TouchableOpacity>

      {showOrgPicker && (<View style={styles.orgDropdown}>
          {orgs.map((org: any) => (<TouchableOpacity key={org.id} style={[styles.orgItem, org.id === activeOrg?.id && styles.orgItemActive]} onPress={async () => {
                    if (org.id !== activeOrg?.id) {
                        await handleSwitchOrg(org.id);
                    }
                    setShowOrgPicker(false);
                }}>
              <View style={[styles.orgItemDot, { backgroundColor: org.color }]}/>
              <Text style={styles.orgItemName} numberOfLines={1}>{org.name}</Text>
              <Text style={styles.orgMode}>{'\u2601'}</Text>
              {org.id === activeOrg?.id && <Text style={styles.orgCheck}>{'\u2713'}</Text>}
            </TouchableOpacity>))}
          <TouchableOpacity style={styles.orgManage} onPress={() => {
                setShowOrgPicker(false);
                navigation.navigate('Settings');
                navigation.closeDrawer();
            }}>
            <Text style={styles.orgManageText}>Manage Organizations</Text>
          </TouchableOpacity>
        </View>)}

      {/* Agents grouped by Project */}
      <ScrollView style={styles.agentList}>
        <View style={styles.connectionRow}>
          <Pressable onLongPress={showConnectionInfo} style={[
            styles.connectionBadge,
            connected
                ? styles.connectionBadgeConnected
                : reconnecting
                    ? styles.connectionBadgeReconnecting
                    : styles.connectionBadgeDisconnected,
        ]} accessibilityRole="text" accessibilityLabel={connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'} testID="sidebar-connection-status">
            <Text style={[
            styles.connectionText,
            connected
                ? styles.connectionTextConnected
                : reconnecting
                    ? styles.connectionTextReconnecting
                    : styles.connectionTextDisconnected,
        ]} numberOfLines={1}>
              {connected ? '● Connected' : reconnecting ? '● Reconnecting…' : '● Disconnected'}
            </Text>
          </Pressable>
          <BugReportButton projectId={bugReportProjectId} agentId={activeAgentId || ''} sourceUrl={activeAgent?.name ? `agent:${activeAgent.name}` : ''} buttonStyle={styles.bugReportButton}/>
        </View>

        {/* Org-scoped Dashboard — sits above the project list. */}
        <TouchableOpacity style={styles.dashboardItem} onPress={() => {
            navigation.navigate('Dashboard');
            navigation.closeDrawer();
        }}>
          <HubIcon name="BarChart3" size={14} color={colors.blue400} style={styles.dashboardIcon}/>
          <Text style={styles.dashboardText}>Dashboard</Text>
        </TouchableOpacity>

        {/* Global Calendar — a per-USER Google surface, not project-scoped.
            Only shown when the user's Google account is connected
            (`/api/auth/google/status` connected=true). When not connected, the
            connect affordance lives in Settings -> Account. */}
        {calendarNavVisible && (
          <TouchableOpacity testID="drawer-global-calendar" style={styles.dashboardItem} onPress={() => {
            navigation.navigate('Calendar');
            navigation.closeDrawer();
          }}>
            <HubIcon name="CalendarDays" size={14} color={colors.blue400} style={styles.dashboardIcon}/>
            <Text style={styles.dashboardText}>Calendar</Text>
          </TouchableOpacity>
        )}

        {/* Global Gmail — a per-USER Google surface, not project-scoped. Only
            shown when the user's Google account is connected
            (`/api/auth/google/status` connected=true). When not connected, the
            connect affordance lives in Settings -> Account. */}
        {gmailNavVisible && (
          <TouchableOpacity testID="drawer-global-gmail" style={styles.dashboardItem} onPress={() => {
            navigation.navigate('Gmail');
            navigation.closeDrawer();
          }}>
            <HubIcon name="Mail" size={14} color={colors.blue400} style={styles.dashboardIcon}/>
            <Text style={styles.dashboardText}>Gmail</Text>
          </TouchableOpacity>
        )}

        {cronSessions.length > 0 && (<View style={{ marginBottom: 16 }}>
            <View style={styles.sectionLabelRow}>
              <HubIcon name="Clock" size={12} color={colors.gray500}/>
              <Text style={[styles.sectionLabel, styles.sectionLabelInline]}>SCHEDULED TASKS</Text>
            </View>
            {cronSessions.map((cs: any) => (<TouchableOpacity key={cs.id} style={[
                    styles.agentItem,
                    activeSessionId === cs.id && styles.agentItemActive,
                ]} onPress={() => handleCronSessionSelect(cs.id)}>
                <SessionStateIcon state={deriveSessionState(cs, {
                    activeTaskSessionIds: activeTasks,
                    finalizeStatusBySession,
                })} testID={`session-state-icon-${cs.id}`}/>
                <View style={styles.agentInfo}>
                  <Text style={[
                    styles.agentName,
                    activeSessionId === cs.id && styles.agentNameActive,
                ]} numberOfLines={1}>
                    {cs.cron_name || cs.name}
                  </Text>
                  <Text style={styles.cronScheduleText}>
                    {humanCron(cs.cron_schedule)}
                  </Text>
                </View>
              </TouchableOpacity>))}
          </View>)}

        {projects.length > 0 && (<>
            <Text style={styles.sectionLabel}>PROJECTS</Text>
            {projects.map((project: any, index: any) => {
                const projectAgents = agents.filter((a: any) => a.projectId === project.id && a.active !== false);
                if (projectAgents.length === 0)
                    return null;
                const isCollapsed = collapsedProjects[project.id];
                return (<View key={project.id}>
                  {index > 0 && <View style={styles.projectDivider}/>}
                  <View style={styles.projectHeaderRow}>
                    <TouchableOpacity style={[styles.projectHeader, { flex: 1 }]} onPress={() => setCollapsedProjects((prev: any) => ({
                        ...prev,
                        [project.id]: !prev[project.id],
                    }))} onLongPress={() => {
                        Alert.alert('Delete Project', `Delete "${project.name}" and all its agents, sessions, board, and wiki data? This cannot be undone.`, [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: async () => {
                                    try {
                                        await api.deleteProject(project.id);
                                        refreshProjects();
                                        refreshAgents();
                                    }
                                    catch (err: any) {
                                        Alert.alert('Error', 'Failed to delete project');
                                    }
                                },
                            },
                        ]);
                    }}>
                      <View style={[styles.projectDot, { backgroundColor: project.color || '#6366f1' }]}/>
                      <Text style={styles.projectName} numberOfLines={1}>
                        {project.name}
                        {isWorkflowProject(project) ? (<Text style={styles.workflowTag}> Wf</Text>) : null}
                      </Text>
                      <Text style={styles.collapseIcon}>
                        {isCollapsed ? '\u25B8' : '\u25BE'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {!isCollapsed && (<>
                      {projectAgents.map((agent: any) => renderAgentRow(agent))}
                      {renderProjectMenu(project)}
                    </>)}
                </View>);
            })}
          </>)}

        {/* Agents without a project (fallback / orphans) */}
        {orphanAgents.length > 0 && (<View>
            <Text style={styles.sectionLabel}>
              {projects.length > 0 ? 'OTHER AGENTS' : 'AGENTS'}
            </Text>
            {orphanAgents.map((agent: any) => renderAgentRow(agent))}
          </View>)}

      </ScrollView>

      {/* Bottom Nav — mirrors the web sidebar footer (Skills, Settings, then
              the server version line). Wiki / Notes now live under each project's
              "Settings" submenu, matching the web sidebar's project-scoped grouping. */}
      <View style={styles.bottomNav}>
        <TouchableOpacity style={styles.navButton} onPress={() => {
            navigation.navigate('Designs');
            navigation.closeDrawer();
        }}>
          <HubIcon name="Palette" size={16} color={colors.purple400} style={styles.navButtonIcon}/>
          <Text style={styles.navButtonText}>Designs</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => {
            navigation.navigate('Skills');
            navigation.closeDrawer();
        }}>
          <HubIcon name="BookOpen" size={16} style={styles.navButtonIcon}/>
          <Text style={styles.navButtonText}>Skills</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => {
            navigation.navigate('Releases');
            navigation.closeDrawer();
        }}>
          <HubIcon name="Sparkles" size={16} style={styles.navButtonIcon}/>
          <Text style={styles.navButtonText}>What's new</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => {
            navigation.navigate('NewProject');
            navigation.closeDrawer();
        }}>
          <HubIcon name="Plus" size={18} strokeWidth={2.5} style={styles.navButtonIcon}/>
          <Text style={styles.navButtonText}>New Project</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => {
            navigation.navigate('Settings');
            navigation.closeDrawer();
        }}>
          <HubIcon name="Settings" size={16} style={styles.navButtonIcon}/>
          <Text style={styles.navButtonText}>Settings</Text>
        </TouchableOpacity>
        {health?.version && (<View style={styles.versionBox}>
            <Text style={styles.versionText}>v{health.version}</Text>
            {health.gitHash && (<Text style={styles.versionHash}>{health.gitHash}</Text>)}
          </View>)}
      </View>
    </SafeAreaView>);
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
    connectionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
    },
    connectionBadge: {
        flex: 1,
        minWidth: 0,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        alignItems: 'center',
    },
    connectionBadgeConnected: {
        backgroundColor: colors.emerald900_50,
    },
    connectionBadgeReconnecting: {
        backgroundColor: colors.yellow900_50,
    },
    connectionBadgeDisconnected: {
        backgroundColor: colors.red900_50,
    },
    connectionText: {
        fontSize: 12,
        textAlign: 'center',
    },
    connectionTextConnected: {
        color: colors.emerald400,
    },
    connectionTextReconnecting: {
        color: colors.yellow400,
    },
    connectionTextDisconnected: {
        color: colors.red400,
    },
    bugReportButton: {
        padding: 8,
        marginRight: 0,
    },
    sectionLabel: {
        fontSize: 10,
        fontWeight: '600',
        color: colors.gray500,
        letterSpacing: 1,
        marginBottom: 8,
        paddingHorizontal: 8,
    },
    sectionLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
        paddingHorizontal: 8,
    },
    sectionLabelInline: {
        marginBottom: 0,
        paddingHorizontal: 0,
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
        flexShrink: 0,
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
    unreadBadge: {
        backgroundColor: colors.rose400,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    securityBadge: {
        backgroundColor: colors.red500,
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 8,
        paddingVertical: 10,
        borderRadius: 6,
        marginBottom: 2,
    },
    sessionItemActive: {
        backgroundColor: colors.gray800,
    },
    sessionName: {
        flex: 1,
        minWidth: 0,
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 8,
    },
    navButtonIcon: {
        flexShrink: 0,
    },
    navButtonText: {
        fontSize: 14,
        color: colors.gray400,
    },
    versionBox: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    versionText: {
        fontSize: 12,
        color: colors.gray500,
    },
    versionHash: {
        fontSize: 10,
        color: colors.gray600,
        marginTop: 1,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    // Per-project "<project> Settings" submenu (mirrors the web sidebar).
    projectMenu: {
        marginLeft: 24,
        marginBottom: 6,
    },
    projectMenuToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
    },
    projectMenuChevron: {
        flexShrink: 0,
    },
    projectMenuGear: {
        flexShrink: 0,
    },
    projectMenuToggleText: {
        flex: 1,
        fontSize: 12,
        color: colors.gray500,
    },
    projectMenuItems: {
        marginLeft: 9,
        paddingLeft: 8,
        borderLeftWidth: 1,
        borderLeftColor: colors.gray800,
    },
    projectMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 6,
    },
    projectMenuItemIcon: {
        flexShrink: 0,
    },
    projectMenuItemText: {
        flex: 1,
        fontSize: 13,
        color: colors.gray400,
    },
});
