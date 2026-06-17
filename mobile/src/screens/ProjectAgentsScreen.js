import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeFuture } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import AgentsSection from '../components/settings/AgentsSection';

function HeartbeatPanel({ agentId, agentName }) {
  const [hb, setHb] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ interval: '', prompt: '', model: '' });
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.getHeartbeats();
      const row = (list || []).find((h) => h.agentId === agentId);
      setHb(row || null);
      if (row?.heartbeat) {
        setForm({
          interval: row.heartbeat.interval || '',
          prompt: row.heartbeat.prompt || '',
          model: row.heartbeat.model || '',
        });
      }
    } catch {
      setHb(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async () => {
    if (!hb) return;
    const next = !hb.heartbeat?.enabled;
    await api.updateHeartbeat(agentId, { enabled: next });
    setHb((prev) =>
      prev ? { ...prev, heartbeat: { ...prev.heartbeat, enabled: next } } : prev,
    );
  };

  const save = async () => {
    if (!form.interval || !form.prompt) {
      Alert.alert('Missing fields', 'Schedule and prompt are required.');
      return;
    }
    await api.updateHeartbeat(agentId, {
      interval: form.interval,
      prompt: form.prompt,
      model: form.model || '',
    });
    setEditing(false);
    await load();
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await api.runHeartbeat(agentId);
    } catch (err) {
      Alert.alert('Run failed', err?.message || 'Could not run heartbeat');
    } finally {
      setTimeout(() => setRunning(false), 3000);
    }
  };

  if (loading) {
    return <ActivityIndicator size="small" color={colors.gray500} style={{ marginTop: 8 }} />;
  }

  const enabled = hb?.heartbeat?.enabled;
  const nextRun = hb?.state?.next_run_at;
  const nextLabel = enabled && nextRun ? relativeFuture(nextRun).label : null;

  return (
    <View style={hbStyles.box}>
      <Text style={hbStyles.title}>Heartbeat — {agentName}</Text>
      {!hb ? (
        <Text style={hbStyles.muted}>No heartbeat configured for this agent.</Text>
      ) : (
        <>
          <View style={hbStyles.row}>
            <TouchableOpacity style={[hbStyles.chip, enabled && hbStyles.chipOn]} onPress={toggle}>
              <Text style={hbStyles.chipText}>{enabled ? 'Enabled' : 'Disabled'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={hbStyles.chip} onPress={runNow} disabled={running}>
              <Text style={hbStyles.chipText}>{running ? 'Running…' : 'Run now'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={hbStyles.chip} onPress={() => setEditing((v) => !v)}>
              <Text style={hbStyles.chipText}>{editing ? 'Cancel' : 'Edit'}</Text>
            </TouchableOpacity>
          </View>
          {nextLabel ? <Text style={hbStyles.muted}>Next: {nextLabel}</Text> : null}
          {editing ? (
            <View style={hbStyles.form}>
              <Text style={hbStyles.label}>Schedule (cron)</Text>
              <TextInput
                style={hbStyles.input}
                value={form.interval}
                onChangeText={(v) => setForm({ ...form, interval: v })}
                placeholder="*/30 * * * *"
                placeholderTextColor={colors.gray600}
              />
              <Text style={hbStyles.label}>Prompt</Text>
              <TextInput
                style={[hbStyles.input, { minHeight: 60 }]}
                value={form.prompt}
                onChangeText={(v) => setForm({ ...form, prompt: v })}
                multiline
                placeholderTextColor={colors.gray600}
              />
              <TouchableOpacity style={hbStyles.saveBtn} onPress={save}>
                <Text style={hbStyles.saveBtnText}>Save heartbeat</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={hbStyles.muted} numberOfLines={2}>
              {form.interval} · {form.prompt}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

export default function ProjectAgentsScreen({ route, navigation }) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects, agents } = useApp();
  const project = routeProject || projects?.find((p) => p.id === projectId);

  const projectAgentIds = useMemo(() => {
    const fromProject = (project?.agents || [])
      .filter((a) => a.role !== 'reviewer')
      .map((a) => a.id);
    const fromList = (agents || [])
      .filter((a) => a.projectId === projectId && a.role !== 'reviewer')
      .map((a) => a.id);
    return [...new Set([...fromProject, ...fromList])];
  }, [project, agents, projectId]);

  const [expandedHb, setExpandedHb] = useState(null);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Agents"
        project={project}
        onBack={() => navigation.goBack()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AgentsSection projectId={projectId} hideBulk />
        {projectAgentIds.length > 0 && (
          <View style={styles.hbSection}>
            <Text style={styles.hbSectionTitle}>Heartbeats</Text>
            <Text style={styles.hbHint}>Per-agent scheduled check-ins for this project.</Text>
            {projectAgentIds.map((agentId) => {
              const agent =
                agents?.find((a) => a.id === agentId) ||
                project?.agents?.find((a) => a.id === agentId);
              const name = agent?.name || agentId;
              const open = expandedHb === agentId;
              return (
                <View key={agentId}>
                  <TouchableOpacity
                    style={styles.hbToggle}
                    onPress={() => setExpandedHb(open ? null : agentId)}
                  >
                    <Text style={styles.hbToggleText}>{name}</Text>
                    <Text style={styles.hbChevron}>{open ? '▲' : '▼'}</Text>
                  </TouchableOpacity>
                  {open && <HeartbeatPanel agentId={agentId} agentName={name} />}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  hbSection: { marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.gray800 },
  hbSectionTitle: { fontSize: 16, fontWeight: '600', color: colors.white, marginBottom: 4 },
  hbHint: { fontSize: 12, color: colors.gray500, marginBottom: 12 },
  hbToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  hbToggleText: { fontSize: 14, color: colors.gray300 },
  hbChevron: { color: colors.gray500 },
});

const hbStyles = StyleSheet.create({
  box: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  title: { fontSize: 13, fontWeight: '600', color: colors.gray300, marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  chipOn: { borderColor: colors.emerald400, backgroundColor: colors.emerald800_50 },
  chipText: { fontSize: 12, color: colors.gray300 },
  muted: { fontSize: 12, color: colors.gray500 },
  form: { marginTop: 8 },
  label: { fontSize: 11, color: colors.gray500, marginBottom: 4 },
  input: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    padding: 8,
    color: colors.white,
    fontSize: 13,
    marginBottom: 8,
  },
  saveBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.emerald800_50,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  saveBtnText: { color: colors.emerald400, fontSize: 12, fontWeight: '600' },
});
