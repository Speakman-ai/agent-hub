import React, { useState, useEffect, useCallback } from 'react';
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
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import ProjectDefaultAutomationSection from '../components/settings/ProjectDefaultAutomationSection';
import ProjectEmailLogoSection from '../components/settings/ProjectEmailLogoSection';
const PROJECT_COLORS = [
  '#6366f1',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];
export default function ProjectSettingsScreen({ route, navigation }: any) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects, refreshProjects } = useApp();
  const project = routeProject || projects?.find((p: any) => p.id === projectId);
  const [name, setName] = useState(project?.name || '');
  const [color, setColor] = useState(project?.color || '#6366f1');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!project) return;
    setName(project.name || '');
    setColor(project.color || '#6366f1');
  }, [project?.id, project?.name, project?.color]);
  const saveField = useCallback(
    async (patch: any) => {
      if (!projectId) return;
      setSaving(true);
      try {
        await api.updateProject(projectId, patch);
        await refreshProjects?.();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to save');
      } finally {
        setSaving(false);
      }
    },
    [projectId, refreshProjects],
  );
  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === project?.name) return;
    await saveField({ name: trimmed });
  };
  const handleColorChange = async (nextColor: any) => {
    setColor(nextColor);
    if (nextColor !== project?.color) await saveField({ color: nextColor });
  };
  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    try {
      await api.deleteProject(projectId);
      await refreshProjects?.();
      navigation.navigate('Chat');
    } catch (err: any) {
      Alert.alert('Delete failed', err?.message || 'Could not delete project');
    } finally {
      setConfirmDelete(false);
    }
  };
  if (!project) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ProjectScreenHeader title="Project Configuration" onBack={() => navigation.goBack()} />
        <Text style={styles.emptyText}>Project not found.</Text>
      </SafeAreaView>
    );
  }
  const githubRepo = project.githubRepo || '';
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Project Configuration"
        project={project}
        onBack={() => navigation.goBack()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {saving && (
          <ActivityIndicator size="small" color={colors.gray400} style={{ marginBottom: 8 }} />
        )}

        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          onBlur={handleSaveName}
          placeholder="Project name"
          placeholderTextColor={colors.gray600}
        />

        <Text style={styles.label}>Color</Text>
        <View style={styles.colorRow}>
          {PROJECT_COLORS.map((c: any) => (
            <TouchableOpacity
              key={c}
              style={[
                styles.colorBtn,
                { backgroundColor: c },
                color === c && styles.colorBtnActive,
              ]}
              onPress={() => handleColorChange(c)}
            />
          ))}
        </View>

        <Text style={styles.label}>GitHub repository</Text>
        <Text style={styles.readOnly}>{githubRepo ? githubRepo : 'No repo linked'}</Text>

        <View style={{ marginTop: 12 }}>
          <ProjectDefaultAutomationSection projectId={projectId} />
        </View>

        <View style={{ marginTop: 12 }}>
          <ProjectEmailLogoSection projectId={projectId} />
        </View>

        <View style={styles.deleteSection}>
          <TouchableOpacity
            style={[styles.deleteBtn, confirmDelete && styles.deleteBtnConfirm]}
            onPress={handleDelete}
          >
            <Text style={[styles.deleteBtnText, confirmDelete && styles.deleteBtnTextConfirm]}>
              {confirmDelete ? 'Confirm Delete Project' : 'Delete Project'}
            </Text>
          </TouchableOpacity>
          {confirmDelete && (
            <Text style={styles.deleteWarning}>
              Permanently deletes agents, sessions, board, wiki, and all project data.
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  label: { fontSize: 12, color: colors.gray400, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.white,
    fontSize: 15,
  },
  readOnly: {
    fontSize: 13,
    color: colors.gray300,
    fontFamily: 'monospace',
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorBtn: { width: 32, height: 32, borderRadius: 8 },
  colorBtnActive: { borderWidth: 2, borderColor: colors.white },
  deleteSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  deleteBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.gray800,
  },
  deleteBtnConfirm: { backgroundColor: colors.red600 },
  deleteBtnText: { fontSize: 13, color: colors.gray500 },
  deleteBtnTextConfirm: { color: colors.white, fontWeight: '600' },
  deleteWarning: { fontSize: 12, color: colors.red400, marginTop: 8 },
  emptyText: { color: colors.gray500, padding: 16, fontSize: 14 },
});
