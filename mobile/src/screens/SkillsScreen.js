import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 12, lineHeight: 18 },
  code_inline: { backgroundColor: colors.gray900, color: colors.emerald400, fontSize: 11, fontFamily: 'monospace', paddingHorizontal: 3 },
  code_block: { backgroundColor: colors.gray900, color: colors.gray200, padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'monospace' },
  fence: { backgroundColor: colors.gray900, color: colors.gray200, padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'monospace' },
  heading1: { color: colors.white, fontSize: 18, fontWeight: 'bold' },
  heading2: { color: colors.white, fontSize: 16, fontWeight: 'bold' },
  heading3: { color: colors.white, fontSize: 14, fontWeight: '600' },
  paragraph: { marginTop: 2, marginBottom: 2 },
  strong: { color: colors.white, fontWeight: 'bold' },
  link: { color: colors.blue400 },
};

function SkillCard({ skill, agentId }) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!fullContent) {
      setLoading(true);
      try {
        const data = await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
      } catch {
        setFullContent('Failed to load skill content.');
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.cardHeader} onPress={handleExpand}>
        <View style={styles.cardHeaderContent}>
          <Text style={styles.cardTitle}>{skill.name}</Text>
          {skill.description && (
            <Text style={styles.cardDescription} numberOfLines={2}>
              {skill.description}
            </Text>
          )}
        </View>
        <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.cardBody}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.gray500} />
          ) : (
            <ScrollView style={styles.cardScroll} nestedScrollEnabled>
              <Markdown style={markdownStyles}>{fullContent || ''}</Markdown>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

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

  if (!content && content !== '') return null;

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.contextHeader}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={styles.contextFilename}>📄 {filename}</Text>
        <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.cardBody}>
          <View style={styles.editButtons}>
            <TouchableOpacity
              style={[styles.editButton, editing && styles.editButtonActive]}
              onPress={() => setEditing(!editing)}
            >
              <Text style={[styles.editButtonText, editing && styles.editButtonTextActive]}>
                {editing ? '📝 Editing' : '✏️ Edit'}
              </Text>
            </TouchableOpacity>
            {editing && (
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSave}
                disabled={saving}
              >
                <Text style={styles.saveButtonText}>
                  {saving ? '⏳ Saving...' : '💾 Save'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {editing ? (
            <TextInput
              value={editContent}
              onChangeText={setEditContent}
              multiline
              style={styles.editTextarea}
              textAlignVertical="top"
            />
          ) : (
            <ScrollView style={styles.cardScroll} nestedScrollEnabled>
              <Markdown style={markdownStyles}>
                {content || '*(empty)*'}
              </Markdown>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

export default function SkillsScreen() {
  const { agents } = useApp();
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || null);
  const [skills, setSkills] = useState([]);
  const [context, setContext] = useState({});
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  useEffect(() => {
    if (!activeAgentId) return;
    setLoadingSkills(true);
    setLoadingContext(true);

    api.getSkills(activeAgentId)
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoadingSkills(false));

    api.getContext(activeAgentId)
      .then(setContext)
      .catch(() => setContext({}))
      .finally(() => setLoadingContext(false));
  }, [activeAgentId]);

  const handleContextSaved = (filename, newContent) => {
    setContext((prev) => ({ ...prev, [filename]: newContent }));
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.pageTitle}>📚 Skills & Context</Text>

        {/* Agent tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.agentTabs}
          contentContainerStyle={styles.agentTabsContent}
        >
          {agents.map((agent) => (
            <TouchableOpacity
              key={agent.id}
              style={[
                styles.agentTab,
                activeAgentId === agent.id && styles.agentTabActive,
              ]}
              onPress={() => setActiveAgentId(agent.id)}
            >
              <View style={[styles.tabDot, { backgroundColor: agent.color }]} />
              <Text
                style={[
                  styles.agentTabText,
                  activeAgentId === agent.id && styles.agentTabTextActive,
                ]}
              >
                {agent.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {activeAgent && (
          <>
            {/* Skills section */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>🧩 Skills</Text>
                <Text style={styles.sectionCount}>({skills.length} installed)</Text>
              </View>
              {loadingSkills ? (
                <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 20 }} />
              ) : skills.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>No skills installed</Text>
                  <Text style={styles.emptyHint}>
                    Add skills to {activeAgent.workspace}/skills/
                  </Text>
                </View>
              ) : (
                <View style={styles.cardList}>
                  {skills.map((skill) => (
                    <SkillCard key={skill.id} skill={skill} agentId={activeAgentId} />
                  ))}
                </View>
              )}
            </View>

            {/* Context Files section */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>📋 Context Files</Text>
                <Text style={styles.sectionCount}>(workspace identity)</Text>
              </View>
              {loadingContext ? (
                <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 20 }} />
              ) : Object.keys(context).length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>No context files found</Text>
                  <Text style={styles.emptyHint}>
                    Add .md files to {activeAgent.workspace}/
                  </Text>
                </View>
              ) : (
                <View style={styles.cardList}>
                  {Object.entries(context).map(([filename, content]) => (
                    <ContextFilePanel
                      key={filename}
                      filename={filename}
                      content={content}
                      agentId={activeAgentId}
                      onSaved={handleContextSaved}
                    />
                  ))}
                </View>
              )}
            </View>
          </>
        )}
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
  agentTabs: {
    marginBottom: 20,
    marginHorizontal: -4,
  },
  agentTabsContent: {
    gap: 6,
    paddingHorizontal: 4,
  },
  agentTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
  },
  agentTabActive: {
    backgroundColor: colors.gray800,
  },
  tabDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  agentTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  agentTabTextActive: {
    color: colors.white,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
  },
  sectionCount: {
    fontSize: 12,
    color: colors.gray500,
  },
  cardList: {
    gap: 8,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  cardHeaderContent: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray100,
  },
  cardDescription: {
    fontSize: 12,
    color: colors.gray400,
    marginTop: 4,
  },
  expandIcon: {
    fontSize: 12,
    color: colors.gray500,
    marginLeft: 12,
  },
  cardBody: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    padding: 14,
  },
  cardScroll: {
    maxHeight: 300,
  },
  contextHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  contextFilename: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray300,
  },
  editButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  editButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.gray700,
  },
  editButtonActive: {
    backgroundColor: 'rgba(30, 64, 175, 0.5)',
  },
  editButtonText: {
    fontSize: 12,
    color: colors.gray400,
  },
  editButtonTextActive: {
    color: colors.blue400,
  },
  saveButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.emerald800_50,
  },
  saveButtonText: {
    fontSize: 12,
    color: colors.emerald400,
  },
  editTextarea: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.gray100,
    fontSize: 12,
    fontFamily: 'monospace',
    minHeight: 200,
    textAlignVertical: 'top',
  },
  emptyCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.gray600,
    marginTop: 4,
    fontFamily: 'monospace',
  },
});
