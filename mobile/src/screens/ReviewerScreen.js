import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';

const mdStyles = {
  body: { color: colors.gray300, fontSize: 13 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  code_inline: { backgroundColor: colors.gray800, color: colors.emerald400, paddingHorizontal: 4, borderRadius: 3 },
  fence: { backgroundColor: colors.gray800, borderRadius: 6, padding: 8 },
  code_block: { color: colors.gray200, fontSize: 12 },
  strong: { color: colors.white },
};

function ContextFilePanel({ filename, content, agentId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditContent(content || '');
  }, [content]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  if (content === null || content === undefined) return null;

  return (
    <View style={panelStyles.card}>
      <TouchableOpacity style={panelStyles.header} onPress={() => setExpanded(!expanded)}>
        <Text style={panelStyles.filename}>{filename}</Text>
        <Text style={panelStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={panelStyles.body}>
          <View style={panelStyles.editRow}>
            <TouchableOpacity
              style={[panelStyles.editBtn, editing && panelStyles.editBtnActive]}
              onPress={() => setEditing(!editing)}
            >
              <Text style={panelStyles.editBtnText}>{editing ? 'Editing' : 'Edit'}</Text>
            </TouchableOpacity>
            {editing && (
              <TouchableOpacity style={panelStyles.saveBtn} onPress={handleSave} disabled={saving}>
                <Text style={panelStyles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            )}
          </View>
          {editing ? (
            <TextInput
              value={editContent}
              onChangeText={setEditContent}
              multiline
              style={panelStyles.textarea}
              textAlignVertical="top"
            />
          ) : (
            <ScrollView style={panelStyles.scroll} nestedScrollEnabled>
              <Markdown style={mdStyles}>{content || '*(empty)*'}</Markdown>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

export default function ReviewerScreen({ route, navigation }) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects } = useApp();
  const project = routeProject || projects?.find((p) => p.id === projectId);

  const reviewerAgent = useMemo(() => {
    const agents = project?.agents || [];
    return agents.find((a) => a.role === 'reviewer') || null;
  }, [project]);

  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!reviewerAgent?.id) {
      setContext(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContext(reviewerAgent.id)
      .then((data) => {
        if (!cancelled) setContext(data || {});
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load reviewer files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewerAgent?.id]);

  const handleSaved = useCallback((filename, newContent) => {
    setContext((prev) => ({ ...(prev || {}), [filename]: newContent }));
  }, []);

  const fileEntries = context ? Object.entries(context) : [];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Reviewer" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.desc}>
          Markdown files that shape the {project?.name || 'project'} reviewer. Edits take effect on
          the next review.
        </Text>
        {!project ? (
          <Text style={styles.empty}>Project not found.</Text>
        ) : !reviewerAgent ? (
          <Text style={styles.empty}>
            No reviewer agent yet. Created automatically once GitHub integration is enabled.
          </Text>
        ) : loading ? (
          <ActivityIndicator color={colors.gray400} style={{ marginTop: 24 }} />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : fileEntries.length === 0 ? (
          <Text style={styles.empty}>No markdown files found for this reviewer.</Text>
        ) : (
          fileEntries.map(([filename, content]) => (
            <ContextFilePanel
              key={filename}
              filename={filename}
              content={content}
              agentId={reviewerAgent.id}
              onSaved={handleSaved}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  desc: { fontSize: 13, color: colors.gray500, marginBottom: 16, lineHeight: 18 },
  empty: { fontSize: 14, color: colors.gray500, backgroundColor: colors.gray900, padding: 16, borderRadius: 8 },
  error: { fontSize: 14, color: colors.red400 },
});

const panelStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  filename: { fontSize: 14, fontWeight: '500', color: colors.gray300, flex: 1 },
  chevron: { color: colors.gray500 },
  body: { borderTopWidth: 1, borderTopColor: colors.gray800, padding: 12 },
  editRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  editBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  editBtnActive: { backgroundColor: colors.blue900_40 },
  editBtnText: { fontSize: 12, color: colors.gray400 },
  saveBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.emerald800_50,
  },
  saveBtnText: { fontSize: 12, color: colors.emerald400 },
  textarea: {
    minHeight: 160,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  scroll: { maxHeight: 280 },
});
