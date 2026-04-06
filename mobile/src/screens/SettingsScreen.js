import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';

// ─── Heartbeats Tab ─────────────────────────────────────────
function HeartbeatSection() {
  const [heartbeats, setHeartbeats] = useState([]);
  const [expandedAgent, setExpandedAgent] = useState(null);
  const [logs, setLogs] = useState({});
  const [running, setRunning] = useState({});

  useEffect(() => {
    api.getHeartbeats().then(setHeartbeats).catch(console.error);
  }, []);

  const loadLogs = async (agentId) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agentId);
    const data = await api.getHeartbeatLogs(agentId, 20);
    setLogs((prev) => ({ ...prev, [agentId]: data }));
  };

  const toggleHeartbeat = async (agentId, current) => {
    await api.updateHeartbeat(agentId, { enabled: !current });
    setHeartbeats((prev) =>
      prev.map((h) =>
        h.agentId === agentId
          ? { ...h, heartbeat: { ...h.heartbeat, enabled: !current } }
          : h
      )
    );
  };

  const triggerRun = async (agentId) => {
    setRunning((prev) => ({ ...prev, [agentId]: true }));
    try {
      await api.runHeartbeat(agentId);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [agentId]: false })), 3000);
  };

  return (
    <View>
      <Text style={styles.sectionTitle}>Agent Heartbeats</Text>
      <View style={styles.cardList}>
        {heartbeats.map((hb) => (
          <View key={hb.agentId} style={styles.card}>
            <View style={styles.cardRow}>
              <View style={[styles.dot, { backgroundColor: hb.color }]} />
              <View style={styles.cardInfo}>
                <View style={styles.row}>
                  <Text style={styles.cardName}>{hb.agentName}</Text>
                  <Text style={styles.mono}>{hb.heartbeat.interval || 'not set'}</Text>
                </View>
                <Text style={styles.cardSubtext} numberOfLines={1}>
                  {hb.heartbeat.prompt || 'No prompt configured'}
                </Text>
                {hb.latestLog && (
                  <Text style={styles.cardMeta}>
                    Last run: {relativeTime(hb.latestLog.timestamp)} —{' '}
                    <Text
                      style={
                        hb.latestLog.status === 'success'
                          ? styles.statusSuccess
                          : hb.latestLog.status === 'error'
                          ? styles.statusError
                          : styles.statusPending
                      }
                    >
                      {hb.latestLog.status}
                    </Text>
                  </Text>
                )}
              </View>
              <View style={styles.actionButtons}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => triggerRun(hb.agentId)}
                  disabled={running[hb.agentId]}
                >
                  <Text style={styles.smallButtonText}>
                    {running[hb.agentId] ? '⏳' : '▶'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.smallButton,
                    hb.heartbeat.enabled ? styles.buttonOn : styles.buttonOff,
                  ]}
                  onPress={() => toggleHeartbeat(hb.agentId, hb.heartbeat.enabled)}
                >
                  <Text
                    style={[
                      styles.smallButtonText,
                      hb.heartbeat.enabled ? styles.buttonOnText : styles.buttonOffText,
                    ]}
                  >
                    {hb.heartbeat.enabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => loadLogs(hb.agentId)}
                >
                  <Text style={styles.smallButtonText}>
                    {expandedAgent === hb.agentId ? '▲' : '▼'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            {expandedAgent === hb.agentId && (
              <View style={styles.logsContainer}>
                {(logs[hb.agentId] || []).length === 0 ? (
                  <Text style={styles.emptyLogsText}>No logs yet</Text>
                ) : (
                  (logs[hb.agentId] || []).map((log) => (
                    <View key={log.id} style={styles.logItem}>
                      <View style={styles.logHeader}>
                        <View
                          style={[
                            styles.logStatusBadge,
                            log.status === 'success'
                              ? styles.logStatusSuccess
                              : log.status === 'error'
                              ? styles.logStatusError
                              : styles.logStatusPending,
                          ]}
                        >
                          <Text
                            style={[
                              styles.logStatusText,
                              log.status === 'success'
                                ? styles.statusSuccess
                                : log.status === 'error'
                                ? styles.statusError
                                : styles.statusPending,
                            ]}
                          >
                            {log.status}
                          </Text>
                        </View>
                        <Text style={styles.logTime}>{relativeTime(log.timestamp)}</Text>
                      </View>
                      <Text style={styles.logResult} numberOfLines={5}>
                        {log.result || '(running...)'}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Cron Jobs Tab ──────────────────────────────────────────
function CronSection() {
  const [crons, setCrons] = useState([]);
  const [running, setRunning] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [cronLogs, setCronLogs] = useState({});
  const [expandedLog, setExpandedLog] = useState(null);
  const [form, setForm] = useState({
    name: '',
    schedule: '',
    prompt: '',
    cwd: '/home/ryan',
    enabled: true,
  });

  const refreshLogs = async (cronList) => {
    const entries = await Promise.all(
      (cronList || crons).map(async (c) => {
        try {
          const logs = await api.getCronLogs(c.id, 3);
          return [c.id, logs];
        } catch {
          return [c.id, []];
        }
      })
    );
    setCronLogs(Object.fromEntries(entries));
  };

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.getCrons();
        setCrons(data);
        await refreshLogs(data);
      } catch (e) {
        console.error(e);
      }
    };
    load();
  }, []);

  const toggleCron = async (cronJob) => {
    const updated = await api.updateCron(cronJob.id, { enabled: !cronJob.enabled });
    setCrons((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const triggerRun = async (id) => {
    setRunning((prev) => ({ ...prev, [id]: true }));
    try {
      await api.runCron(id);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [id]: false })), 3000);
  };

  const deleteCron = async (id) => {
    Alert.alert('Delete Cron', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.deleteCron(id);
          setCrons((prev) => prev.filter((c) => c.id !== id));
        },
      },
    ]);
  };

  const createCron = async () => {
    if (!form.name || !form.schedule || !form.prompt) {
      Alert.alert('Missing fields', 'Name, schedule, and prompt are required.');
      return;
    }
    const created = await api.createCron(form);
    setCrons((prev) => [...prev, created]);
    setShowForm(false);
    setForm({ name: '', schedule: '', prompt: '', cwd: '/home/ryan', enabled: true });
  };

  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Cron Jobs</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowForm(!showForm)}>
          <Text style={styles.headerButtonText}>{showForm ? 'Cancel' : '+ New Cron'}</Text>
        </TouchableOpacity>
      </View>

      {showForm && (
        <View style={styles.formCard}>
          <TextInput
            value={form.name}
            onChangeText={(v) => setForm({ ...form, name: v })}
            placeholder="Name"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TextInput
            value={form.schedule}
            onChangeText={(v) => setForm({ ...form, schedule: v })}
            placeholder="Cron schedule (e.g. */30 * * * *)"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TextInput
            value={form.prompt}
            onChangeText={(v) => setForm({ ...form, prompt: v })}
            placeholder="Prompt"
            placeholderTextColor={colors.gray500}
            style={[styles.formInput, { minHeight: 80 }]}
            multiline
            textAlignVertical="top"
          />
          <TextInput
            value={form.cwd}
            onChangeText={(v) => setForm({ ...form, cwd: v })}
            placeholder="Working directory"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TouchableOpacity style={styles.createButton} onPress={createCron}>
            <Text style={styles.createButtonText}>Create</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.cardList}>
        {crons.map((cronJob) => (
          <View key={cronJob.id} style={styles.card}>
            <View style={styles.cardRow}>
              <View style={styles.cardInfo}>
                <View style={styles.row}>
                  <Text style={styles.cardName}>{cronJob.name}</Text>
                  <Text style={styles.mono}>{cronJob.schedule}</Text>
                </View>
                <Text style={styles.cardSubtext} numberOfLines={1}>
                  {cronJob.prompt}
                </Text>
                <Text style={styles.cardMeta}>
                  cwd: {cronJob.cwd}
                  {cronJob.last_run && ` · Last: ${relativeTime(cronJob.last_run)}`}
                </Text>
                {/* Recent runs — clickable status dots */}
                {cronLogs[cronJob.id]?.length > 0 && (
                  <View style={{ marginTop: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 11, color: colors.gray500 }}>Runs:</Text>
                      {cronLogs[cronJob.id].map((log) => {
                        const key = `${cronJob.id}:${log.id}`;
                        const isExpanded = expandedLog === key;
                        const dotColor =
                          log.status === 'success' ? '#10b981' :
                          log.status === 'error' ? '#ef4444' :
                          log.status === 'running' ? '#fbbf24' : '#6b7280';
                        return (
                          <TouchableOpacity
                            key={log.id}
                            onPress={() => setExpandedLog(isExpanded ? null : key)}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              paddingHorizontal: 6,
                              paddingVertical: 3,
                              borderRadius: 4,
                              backgroundColor: isExpanded ? colors.gray700 : colors.gray800,
                              borderWidth: isExpanded ? 1 : 0,
                              borderColor: colors.gray600,
                            }}
                          >
                            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor }} />
                            <Text style={{ fontSize: 10, color: colors.gray400 }}>
                              {relativeTime(log.timestamp)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {cronLogs[cronJob.id].map((log) => {
                      const key = `${cronJob.id}:${log.id}`;
                      if (expandedLog !== key) return null;
                      return (
                        <View key={`detail-${log.id}`} style={{
                          marginTop: 8,
                          backgroundColor: colors.gray900,
                          borderRadius: 8,
                          padding: 10,
                          borderWidth: 1,
                          borderColor: colors.gray700,
                        }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text style={{
                                fontSize: 11,
                                fontWeight: '600',
                                color: log.status === 'success' ? '#10b981' :
                                       log.status === 'error' ? '#ef4444' :
                                       log.status === 'running' ? '#fbbf24' : colors.gray400,
                              }}>
                                {log.status === 'success' ? '✓ Success' :
                                 log.status === 'error' ? '✗ Error' :
                                 log.status === 'running' ? '⏳ Running' : log.status}
                              </Text>
                              <Text style={{ fontSize: 10, color: colors.gray500 }}>
                                {new Date(log.timestamp).toLocaleString()}
                              </Text>
                              {log.duration_ms != null && (
                                <Text style={{ fontSize: 10, color: colors.gray500, fontFamily: 'monospace' }}>
                                  {(log.duration_ms / 1000).toFixed(1)}s
                                </Text>
                              )}
                            </View>
                            <TouchableOpacity onPress={() => setExpandedLog(null)}>
                              <Text style={{ fontSize: 11, color: colors.gray500 }}>✕</Text>
                            </TouchableOpacity>
                          </View>
                          {log.result ? (
                            <ScrollView style={{ maxHeight: 160 }}>
                              <Text style={{ fontSize: 11, color: colors.gray400, fontFamily: 'monospace' }}>
                                {log.result}
                              </Text>
                            </ScrollView>
                          ) : (
                            <Text style={{ fontSize: 11, color: colors.gray600, fontStyle: 'italic' }}>
                              No output yet
                            </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
              <View style={styles.actionButtons}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => triggerRun(cronJob.id)}
                  disabled={running[cronJob.id]}
                >
                  <Text style={styles.smallButtonText}>
                    {running[cronJob.id] ? '⏳' : '▶'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.smallButton,
                    cronJob.enabled ? styles.buttonOn : styles.buttonOff,
                  ]}
                  onPress={() => toggleCron(cronJob)}
                >
                  <Text
                    style={[
                      styles.smallButtonText,
                      cronJob.enabled ? styles.buttonOnText : styles.buttonOffText,
                    ]}
                  >
                    {cronJob.enabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => deleteCron(cronJob.id)}
                >
                  <Text style={styles.deleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ))}
        {crons.length === 0 && (
          <Text style={styles.emptyText}>No cron jobs configured</Text>
        )}
      </View>
    </View>
  );
}

// ─── Slack Tab ──────────────────────────────────────────────
function SlackSection() {
  const [status, setStatus] = useState([]);
  const [messages, setMessages] = useState([]);
  const [restarting, setRestarting] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = async () => {
    try {
      const data = await api.getSlackStatus();
      setStatus(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (agentId) => {
    try {
      const data = await api.getSlackMessages(agentId, 20);
      setMessages(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadStatus();
    loadMessages();
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartSlack();
      await loadStatus();
    } catch {
      // ignore
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 40 }} />;
  }

  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Slack Bots</Text>
        <TouchableOpacity
          style={styles.headerButton}
          onPress={handleRestart}
          disabled={restarting}
        >
          <Text style={styles.headerButtonText}>
            {restarting ? '⏳ Restarting...' : '🔄 Restart All'}
          </Text>
        </TouchableOpacity>
      </View>

      {status.length === 0 ? (
        <Text style={styles.emptyText}>No Slack accounts configured</Text>
      ) : (
        <View style={styles.cardList}>
          {status.map((bot) => (
            <TouchableOpacity
              key={bot.name}
              style={styles.card}
              onPress={() => {
                if (selectedAgent === bot.agentId) {
                  setSelectedAgent(null);
                  loadMessages();
                } else {
                  setSelectedAgent(bot.agentId);
                  loadMessages(bot.agentId);
                }
              }}
            >
              <View style={styles.cardRow}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: bot.connected ? colors.emerald400 : colors.red400 },
                  ]}
                />
                <View style={styles.cardInfo}>
                  <View style={styles.row}>
                    <Text style={styles.cardName}>{bot.name}</Text>
                    <View style={styles.agentIdBadge}>
                      <Text style={styles.agentIdText}>→ {bot.agentId}</Text>
                    </View>
                  </View>
                  {bot.error && <Text style={styles.errorText}>{bot.error}</Text>}
                  {bot.lastMessage && (
                    <Text style={styles.cardMeta}>
                      Last message: {relativeTime(bot.lastMessage)}
                    </Text>
                  )}
                </View>
                <View
                  style={[
                    styles.statusPill,
                    bot.connected ? styles.statusPillConnected : styles.statusPillDisconnected,
                  ]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      bot.connected ? styles.statusPillTextConnected : styles.statusPillTextDisconnected,
                    ]}
                  >
                    {bot.connected ? 'Connected' : 'Disconnected'}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Recent messages */}
      <View style={styles.messagesSection}>
        <Text style={styles.messagesTitle}>
          Recent Messages{selectedAgent ? ` (${selectedAgent})` : ''}
        </Text>
        {messages.length === 0 ? (
          <Text style={styles.emptyLogsText}>No messages yet</Text>
        ) : (
          messages.map((msg) => (
            <View key={msg.id} style={styles.slackMessage}>
              <View style={styles.row}>
                <Text style={styles.mono}>{msg.agent_id}</Text>
                <Text style={styles.cardMeta}>{relativeTime(msg.timestamp)}</Text>
              </View>
              <Text style={styles.slackUserMsg} numberOfLines={3}>
                User: {msg.user_message?.substring(0, 200)}
              </Text>
              <Text style={styles.slackBotMsg} numberOfLines={4}>
                Bot: {msg.bot_response?.substring(0, 300)}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ─── Agent Config Tab ───────────────────────────────────────
function AgentConfigSection() {
  const { agents: contextAgents, refreshAgents } = useApp();
  const [agents, setAgents] = useState(contextAgents);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [edits, setEdits] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({
    id: '',
    name: '',
    engine: 'claude-code',
    cwd: '/home/ryan',
    workspace: '',
    color: '#6b7280',
    systemPrompt: '',
  });

  useEffect(() => {
    setAgents(contextAgents);
  }, [contextAgents]);

  const getEdit = (agentId) => {
    if (edits[agentId]) return edits[agentId];
    return agents.find((a) => a.id === agentId) || {};
  };

  const setEdit = (agentId, field, value) => {
    setEdits((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] || agents.find((a) => a.id === agentId)), [field]: value },
    }));
  };

  const handleSave = async (agentId) => {
    setSaving((prev) => ({ ...prev, [agentId]: true }));
    try {
      const data = edits[agentId];
      if (!data) return;
      const { id, lastActivity, lastMessage, ...payload } = data;
      await api.updateAgent(agentId, payload);
      setEdits((prev) => {
        const n = { ...prev };
        delete n[agentId];
        return n;
      });
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'saved' }));
      refreshAgents();
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 2000);
    } catch {
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'error' }));
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 3000);
    } finally {
      setSaving((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  const handleCreate = async () => {
    if (!newForm.id) {
      Alert.alert('Missing ID', 'Agent ID is required.');
      return;
    }
    try {
      await api.createAgent(newForm);
      setShowNew(false);
      setNewForm({ id: '', name: '', engine: 'claude-code', cwd: '/home/ryan', workspace: '', color: '#6b7280', systemPrompt: '' });
      refreshAgents();
    } catch (e) {
      Alert.alert('Error', 'Failed to create agent.');
    }
  };

  const handleDelete = (agentId) => {
    Alert.alert('Delete Agent', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.deleteAgent(agentId);
          refreshAgents();
          setExpanded(null);
        },
      },
    ]);
  };

  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Agent Configurations</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowNew(!showNew)}>
          <Text style={styles.headerButtonText}>{showNew ? 'Cancel' : '+ New Agent'}</Text>
        </TouchableOpacity>
      </View>

      {showNew && (
        <View style={styles.formCard}>
          <TextInput
            value={newForm.id}
            onChangeText={(v) => setNewForm({ ...newForm, id: v })}
            placeholder="ID (alphanumeric + hyphens)"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
            autoCapitalize="none"
          />
          <TextInput
            value={newForm.name}
            onChangeText={(v) => setNewForm({ ...newForm, name: v })}
            placeholder="Name"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TextInput
            value={newForm.cwd}
            onChangeText={(v) => setNewForm({ ...newForm, cwd: v })}
            placeholder="Working Directory"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TextInput
            value={newForm.workspace}
            onChangeText={(v) => setNewForm({ ...newForm, workspace: v })}
            placeholder="Workspace"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <TextInput
            value={newForm.systemPrompt}
            onChangeText={(v) => setNewForm({ ...newForm, systemPrompt: v })}
            placeholder="System Prompt"
            placeholderTextColor={colors.gray500}
            style={[styles.formInput, { minHeight: 80 }]}
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity style={styles.createButton} onPress={handleCreate}>
            <Text style={styles.createButtonText}>Create Agent</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.cardList}>
        {agents.map((agent) => {
          const isExpanded = expanded === agent.id;
          const edit = getEdit(agent.id);
          const isDirty = !!edits[agent.id];
          return (
            <View key={agent.id} style={styles.card}>
              <TouchableOpacity
                style={styles.cardRow}
                onPress={() => setExpanded(isExpanded ? null : agent.id)}
              >
                <View style={[styles.dot, { backgroundColor: agent.color }]} />
                <View style={styles.cardInfo}>
                  <View style={styles.row}>
                    <Text style={styles.cardName}>{agent.name}</Text>
                    <Text style={styles.mono}>{agent.id}</Text>
                    <Text style={styles.cardMeta}>{agent.engine}</Text>
                  </View>
                  <Text style={[styles.cardMeta, styles.mono]} numberOfLines={1}>
                    {agent.cwd}
                  </Text>
                </View>
                <View style={styles.row}>
                  {saveStatus[agent.id] === 'saved' && (
                    <Text style={styles.statusSuccess}>✓ Saved</Text>
                  )}
                  <Text style={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</Text>
                </View>
              </TouchableOpacity>

              {isExpanded && (
                <View style={styles.expandedSection}>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    value={edit.name || ''}
                    onChangeText={(v) => setEdit(agent.id, 'name', v)}
                    style={styles.formInput}
                  />

                  <Text style={styles.fieldLabel}>Engine</Text>
                  <View style={styles.engineToggle}>
                    {['claude-code', 'cursor-agent'].map((eng) => (
                      <TouchableOpacity
                        key={eng}
                        style={[
                          styles.engineOption,
                          (edit.engine || 'claude-code') === eng && styles.engineOptionActive,
                        ]}
                        onPress={() => setEdit(agent.id, 'engine', eng)}
                      >
                        <Text
                          style={[
                            styles.engineOptionText,
                            (edit.engine || 'claude-code') === eng && styles.engineOptionTextActive,
                          ]}
                        >
                          {eng}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={styles.fieldLabel}>Working Directory</Text>
                  <TextInput
                    value={edit.cwd || ''}
                    onChangeText={(v) => setEdit(agent.id, 'cwd', v)}
                    style={styles.formInput}
                  />

                  <Text style={styles.fieldLabel}>Workspace</Text>
                  <TextInput
                    value={edit.workspace || ''}
                    onChangeText={(v) => setEdit(agent.id, 'workspace', v)}
                    style={styles.formInput}
                  />

                  <Text style={styles.fieldLabel}>System Prompt</Text>
                  <TextInput
                    value={edit.systemPrompt || ''}
                    onChangeText={(v) => setEdit(agent.id, 'systemPrompt', v)}
                    style={[styles.formInput, { minHeight: 100 }]}
                    multiline
                    textAlignVertical="top"
                  />

                  <View style={styles.expandedActions}>
                    <TouchableOpacity
                      onPress={() => handleDelete(agent.id)}
                      style={styles.deleteButton}
                    >
                      <Text style={styles.deleteButtonText}>Delete Agent</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleSave(agent.id)}
                      disabled={!isDirty || saving[agent.id]}
                      style={[styles.saveAgentButton, (!isDirty || saving[agent.id]) && { opacity: 0.5 }]}
                    >
                      <Text style={styles.saveAgentButtonText}>
                        {saving[agent.id] ? 'Saving...' : 'Save'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          );
        })}
        {agents.length === 0 && (
          <Text style={styles.emptyText}>No agents configured</Text>
        )}
      </View>
    </View>
  );
}

// ─── Main Settings Screen ───────────────────────────────────
export default function SettingsScreen() {
  const [tab, setTab] = useState('heartbeats');

  const tabs = [
    { id: 'heartbeats', label: '💓 Heartbeats' },
    { id: 'crons', label: '⏰ Crons' },
    { id: 'slack', label: '💬 Slack' },
    { id: 'agents', label: '🤖 Agents' },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.pageTitle}>Settings</Text>

        {/* Tab bar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {tabs.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.tabItem, tab === t.id && styles.tabItemActive]}
              onPress={() => setTab(t.id)}
            >
              <Text style={[styles.tabItemText, tab === t.id && styles.tabItemTextActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {tab === 'heartbeats' && <HeartbeatSection />}
        {tab === 'crons' && <CronSection />}
        {tab === 'slack' && <SlackSection />}
        {tab === 'agents' && <AgentConfigSection />}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    marginBottom: 20,
  },
  tabBar: {
    marginBottom: 20,
    marginHorizontal: -4,
  },
  tabBarContent: {
    gap: 6,
    paddingHorizontal: 4,
  },
  tabItem: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  tabItemActive: {
    backgroundColor: colors.gray800,
  },
  tabItemText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  tabItemTextActive: {
    color: colors.white,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerButton: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  headerButtonText: {
    fontSize: 12,
    color: colors.gray300,
  },
  cardList: {
    gap: 8,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  cardName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.white,
  },
  mono: {
    fontSize: 11,
    color: colors.gray500,
    fontFamily: 'monospace',
  },
  cardSubtext: {
    fontSize: 12,
    color: colors.gray500,
    marginTop: 2,
  },
  cardMeta: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  smallButton: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    color: colors.gray400,
  },
  buttonOn: {
    backgroundColor: colors.emerald800_50,
  },
  buttonOnText: {
    color: colors.emerald400,
  },
  buttonOff: {
    backgroundColor: colors.gray700,
  },
  buttonOffText: {
    color: colors.gray400,
  },
  statusSuccess: {
    color: colors.emerald400,
    fontSize: 12,
  },
  statusError: {
    color: colors.red400,
    fontSize: 12,
  },
  statusPending: {
    color: colors.yellow400,
    fontSize: 12,
  },
  deleteText: {
    fontSize: 12,
    color: colors.gray500,
  },
  expandIcon: {
    fontSize: 12,
    color: colors.gray400,
  },
  // Logs
  logsContainer: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    padding: 14,
    maxHeight: 256,
  },
  emptyLogsText: {
    fontSize: 12,
    color: colors.gray500,
  },
  logItem: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  logStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  logStatusSuccess: {
    backgroundColor: colors.emerald900_50,
  },
  logStatusError: {
    backgroundColor: colors.red900_50,
  },
  logStatusPending: {
    backgroundColor: colors.yellow900_50,
  },
  logStatusText: {
    fontSize: 11,
  },
  logTime: {
    fontSize: 11,
    color: colors.gray500,
  },
  logResult: {
    fontSize: 11,
    color: colors.gray300,
    fontFamily: 'monospace',
  },
  // Form
  formCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  formInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  createButton: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  createButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
  },
  // Agent config
  fieldLabel: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 10,
  },
  engineToggle: {
    flexDirection: 'row',
    gap: 8,
  },
  engineOption: {
    flex: 1,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  engineOptionActive: {
    borderColor: colors.blue600,
    backgroundColor: 'rgba(37, 99, 235, 0.1)',
  },
  engineOptionText: {
    fontSize: 13,
    color: colors.gray400,
  },
  engineOptionTextActive: {
    color: colors.blue400,
  },
  expandedSection: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    padding: 14,
  },
  expandedActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  deleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  deleteButtonText: {
    fontSize: 13,
    color: colors.gray500,
  },
  saveAgentButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  saveAgentButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
  },
  // Slack
  agentIdBadge: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  agentIdText: {
    fontSize: 11,
    color: colors.gray300,
    fontFamily: 'monospace',
  },
  errorText: {
    fontSize: 12,
    color: colors.red400,
    marginTop: 2,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusPillConnected: {
    backgroundColor: colors.emerald800_50,
  },
  statusPillDisconnected: {
    backgroundColor: colors.red900_50,
  },
  statusPillText: {
    fontSize: 11,
  },
  statusPillTextConnected: {
    color: colors.emerald400,
  },
  statusPillTextDisconnected: {
    color: colors.red400,
  },
  messagesSection: {
    marginTop: 20,
  },
  messagesTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray400,
    marginBottom: 10,
  },
  slackMessage: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  slackUserMsg: {
    fontSize: 12,
    color: colors.blue300,
    marginTop: 4,
  },
  slackBotMsg: {
    fontSize: 12,
    color: colors.gray300,
    marginTop: 2,
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
});
