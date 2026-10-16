import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import humanCron from '@shared/utils/humanCron';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { backgroundAgentsPatch, DEFAULT_BACKGROUND_SCHEDULE } from '../utils/backgroundAgents';
import {
  backgroundAgentsFormReducer,
  initialBackgroundAgentsForm,
} from '../utils/backgroundAgentsForm';

const DEFAULT_SCHEDULE = DEFAULT_BACKGROUND_SCHEDULE;

export default function BackgroundAgentsScreen({ route, navigation }: any) {
  const { projects, refreshProjects } = useApp();
  const projectId = route?.params?.projectId;
  const project = useMemo(
    () => (projects || []).find((p: any) => p.id === projectId) || route?.params?.project || null,
    [projects, projectId, route?.params?.project],
  );
  // The editor is remounted per project, so nothing typed for one project can
  // be saved to another when the retained screen gets new route params.
  return (
    <BackgroundAgentsEditor
      key={projectId || ''}
      projectId={projectId}
      project={project}
      refreshProjects={refreshProjects}
      navigation={navigation}
    />
  );
}

function BackgroundAgentsEditor({ projectId, project, refreshProjects, navigation }: any) {
  const [form, dispatch] = useReducer(
    backgroundAgentsFormReducer,
    project,
    initialBackgroundAgentsForm,
  );
  const { wiki, custom } = form;
  // Nothing is editable until the project's saved config has loaded.
  const locked = !form.loaded;
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // Every form change goes through one edit action so the reducer can tell
  // the user's input apart from the server's config.
  const setWiki = (update: (prev: any) => any) =>
    dispatch({ type: 'edit', update: (f) => ({ ...f, wiki: update(f.wiki) }) });
  const setCustom = (update: (prev: any[]) => any[]) =>
    dispatch({ type: 'edit', update: (f) => ({ ...f, custom: update(f.custom) }) });

  // Take the saved config whenever it changes (first load, a refresh after
  // this or another device saved); the reducer ignores it while dirty.
  const projectRef = useRef(project);
  projectRef.current = project;
  const savedKey = project ? JSON.stringify(project.backgroundAgents ?? null) : null;
  useEffect(() => {
    if (savedKey !== null) dispatch({ type: 'hydrate', project: projectRef.current });
  }, [savedKey]);

  const save = async () => {
    if (!projectId || !project || locked) return;
    for (const agent of custom) {
      if (!String(agent.name || '').trim() || !String(agent.prompt || '').trim()) {
        Alert.alert('Background agents', 'Every custom agent needs a name and a prompt.');
        return;
      }
    }
    const submitted = form.edits;
    setSaving(true);
    try {
      await api.updateProject(projectId, backgroundAgentsPatch(wiki, custom, project?.mode));
      dispatch({ type: 'saved', edits: submitted });
      refreshProjects?.();
      Alert.alert('Background agents', 'Saved.');
    } catch (err: any) {
      Alert.alert('Background agents', err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const run = async (agentId: string) => {
    if (!projectId) return;
    setRunningId(agentId);
    try {
      await api.runBackgroundAgent(projectId, agentId);
      Alert.alert('Background agents', 'Run started.');
    } catch (err: any) {
      Alert.alert('Background agents', err?.message || 'Failed to start run');
    } finally {
      setRunningId(null);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Background Agents"
        project={project}
        onBack={() => navigation.goBack()}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.lead}>
          Scheduled, unattended AI jobs for this project. Each runs on a cadence you set.
        </Text>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Wiki</Text>
            <Switch
              disabled={locked}
              testID="wiki-agent-enabled"
              value={!!wiki.enabled}
              onValueChange={(enabled) => setWiki((prev: any) => ({ ...prev, enabled }))}
            />
          </View>
          <Text style={styles.cardBody}>
            Keeps the project wiki current by reviewing undocumented Done cards.
          </Text>
          <Text style={styles.label}>Schedule</Text>
          <TextInput
            editable={!locked}
            style={styles.input}
            value={wiki.schedule || ''}
            onChangeText={(schedule) => setWiki((prev: any) => ({ ...prev, schedule }))}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>{humanCron(wiki.schedule)}</Text>
          <TouchableOpacity
            style={styles.secondary}
            disabled={locked || runningId === 'wiki'}
            onPress={() => run('wiki')}
          >
            {runningId === 'wiki' ? (
              <ActivityIndicator color={colors.gray200} />
            ) : (
              <Text style={styles.secondaryText}>Run now</Text>
            )}
          </TouchableOpacity>
        </View>

        {custom.map((agent, index) => (
          <View key={agent.id || index} style={styles.card}>
            <View style={styles.cardHeader}>
              <TextInput
                editable={!locked}
                style={[styles.input, styles.nameInput]}
                value={agent.name || ''}
                placeholder="Agent name"
                placeholderTextColor={colors.gray600}
                onChangeText={(name) =>
                  setCustom((prev) => prev.map((row, i) => (i === index ? { ...row, name } : row)))
                }
              />
              <Switch
                disabled={locked}
                value={!!agent.enabled}
                onValueChange={(enabled) =>
                  setCustom((prev) =>
                    prev.map((row, i) => (i === index ? { ...row, enabled } : row)),
                  )
                }
              />
            </View>
            <Text style={styles.label}>Schedule</Text>
            <TextInput
              editable={!locked}
              style={styles.input}
              value={agent.schedule || ''}
              onChangeText={(schedule) =>
                setCustom((prev) =>
                  prev.map((row, i) => (i === index ? { ...row, schedule } : row)),
                )
              }
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>{humanCron(agent.schedule)}</Text>
            <Text style={styles.label}>Prompt</Text>
            <TextInput
              editable={!locked}
              style={[styles.input, styles.prompt]}
              value={agent.prompt || ''}
              multiline
              onChangeText={(prompt) =>
                setCustom((prev) => prev.map((row, i) => (i === index ? { ...row, prompt } : row)))
              }
            />
            <TouchableOpacity
              style={styles.secondary}
              disabled={locked || !agent.id || runningId === agent.id}
              onPress={() => agent.id && run(agent.id)}
            >
              <Text style={styles.secondaryText}>Run now</Text>
            </TouchableOpacity>
          </View>
        ))}

        <TouchableOpacity
          style={styles.secondary}
          disabled={locked}
          testID="background-agents-add"
          onPress={() =>
            setCustom((prev) => [
              ...prev,
              {
                id: `bg-${Date.now()}`,
                name: '',
                prompt: '',
                enabled: false,
                schedule: DEFAULT_SCHEDULE,
              },
            ])
          }
        >
          <Text style={styles.secondaryText}>Add agent</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.primary}
          disabled={saving || locked || !project}
          onPress={save}
          testID="background-agents-save"
        >
          <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  lead: { color: colors.gray500, fontSize: 12 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    gap: 8,
    backgroundColor: colors.gray900,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: { color: colors.white, fontSize: 15, fontWeight: '600' },
  cardBody: { color: colors.gray500, fontSize: 12 },
  label: { color: colors.gray400, fontSize: 12 },
  hint: { color: colors.gray600, fontSize: 11 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    color: colors.gray200,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 14,
  },
  nameInput: { flex: 1 },
  prompt: { minHeight: 80, textAlignVertical: 'top' },
  primary: {
    backgroundColor: colors.indigo600,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryText: { color: colors.white, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  secondaryText: { color: colors.gray200, fontSize: 13 },
});
