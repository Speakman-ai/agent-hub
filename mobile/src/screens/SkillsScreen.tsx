import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
const CATEGORY_STYLES: Record<string, any> = {
    platform: { bg: colors.indigo900_40, fg: colors.indigo400 },
    development: { bg: colors.blue900_40, fg: colors.blue400 },
    documentation: { bg: colors.emerald900_40, fg: colors.emerald400 },
    automation: { bg: colors.amber900_40, fg: colors.amber400 },
    git: { bg: colors.purple900_40, fg: colors.purple400 },
    monitoring: { bg: colors.rose900_40, fg: colors.rose400 },
    general: { bg: colors.gray700_40, fg: colors.gray400 },
};
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
function CategoryBadge({ category }: any) {
    const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
    return (<View style={[styles.categoryBadge, { backgroundColor: style.bg }]}>
      <Text style={[styles.categoryBadgeText, { color: style.fg }]}>{category}</Text>
    </View>);
}
function SkillCard({ skill, agentId, projectId, overrides, onToggle, onUninstall, isInstalled }: any) {
    const [expanded, setExpanded] = useState(false);
    const [fullContent, setFullContent] = useState(skill.content || null);
    const [loading, setLoading] = useState(false);
    const override = overrides?.find((o: any) => o.skill_id === skill.id);
    const isEnabled = override ? !!override.enabled : true;
    const handleExpand = async () => {
        if (expanded) {
            setExpanded(false);
            return;
        }
        const canReadProject = skill.source === 'project' && projectId;
        if (!fullContent && (agentId || skill.source === 'global' || canReadProject)) {
            setLoading(true);
            try {
                // Read from the tier the skill lives in: global → global tier;
                // project → the project-owned read (works without an agent);
                // otherwise → the agent-scoped merged read.
                const data = skill.source === 'global'
                    ? await api.getGlobalSkill(skill.id)
                    : canReadProject
                        ? await api.getProjectSkill(projectId, skill.id)
                        : await api.getSkill(agentId, skill.id);
                setFullContent(data.content);
            }
            catch {
                setFullContent('Failed to load skill content.');
            }
            finally {
                setLoading(false);
            }
        }
        setExpanded(true);
    };
    return (<View style={[styles.card, !isEnabled && styles.cardDisabled]}>
      <TouchableOpacity style={styles.cardHeader} onPress={handleExpand}>
        <View style={styles.cardHeaderContent}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {skill.name}
            </Text>
            <CategoryBadge category={skill.category || 'general'}/>
            {skill.source === 'default' && (<View style={[styles.categoryBadge, { backgroundColor: colors.gray700_40 }]}>
                <Text style={[styles.categoryBadgeText, { color: colors.gray500 }]}>built-in</Text>
              </View>)}
            {skill.source === 'global' && (<View style={[styles.categoryBadge, { backgroundColor: colors.blue900_40 }]}>
                <Text style={[styles.categoryBadgeText, { color: colors.blue400 }]}>shared</Text>
              </View>)}
          </View>
          {skill.description && (<Text style={styles.cardDescription} numberOfLines={2}>
              {skill.description}
            </Text>)}
        </View>
        <View style={styles.cardHeaderActions}>
          {onToggle && (<TouchableOpacity onPress={(e: any) => {
                e.stopPropagation?.();
                onToggle(skill.id, !isEnabled);
            }} style={styles.iconButton} hitSlop={8}>
              <Text style={[styles.toggleText, isEnabled && styles.toggleTextActive]}>
                {isEnabled ? '● on' : '○ off'}
              </Text>
            </TouchableOpacity>)}
          {onUninstall && isInstalled && skill.source !== 'default' && (<TouchableOpacity onPress={(e: any) => {
                e.stopPropagation?.();
                onUninstall(skill.id, skill.source);
            }} style={styles.iconButton} hitSlop={8}>
              <Text style={styles.trashText}>Del</Text>
            </TouchableOpacity>)}
          <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>
      {expanded && (<View style={styles.cardBody}>
          {loading ? (<ActivityIndicator size="small" color={colors.gray500}/>) : (<ScrollView style={styles.cardScroll} nestedScrollEnabled>
              <Markdown style={markdownStyles as any}>{fullContent || ''}</Markdown>
            </ScrollView>)}
        </View>)}
    </View>);
}
function ContextFilePanel({ filename, content, agentId, onSaved }: any) {
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
            if (onSaved)
                onSaved(filename, editContent);
        }
        catch (err: any) {
            console.error('Failed to save:', err);
        }
        finally {
            setSaving(false);
        }
    };
    if (!content && content !== '')
        return null;
    return (<View style={styles.card}>
      <TouchableOpacity style={styles.contextHeader} onPress={() => setExpanded(!expanded)}>
        <Text style={styles.contextFilename}>{filename}</Text>
        <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (<View style={styles.cardBody}>
          <View style={styles.editButtons}>
            <TouchableOpacity style={[styles.editButton, editing && styles.editButtonActive]} onPress={() => setEditing(!editing)}>
              <Text style={[styles.editButtonText, editing && styles.editButtonTextActive]}>
                {editing ? 'Editing' : 'Edit'}
              </Text>
            </TouchableOpacity>
            {editing && (<TouchableOpacity style={styles.saveButton} onPress={handleSave} disabled={saving}>
                <Text style={styles.saveButtonText}>
                  {saving ? 'Saving...' : 'Save'}
                </Text>
              </TouchableOpacity>)}
          </View>
          {editing ? (<TextInput value={editContent} onChangeText={setEditContent} multiline style={styles.editTextarea} textAlignVertical="top"/>) : (<ScrollView style={styles.cardScroll} nestedScrollEnabled>
              <Markdown style={markdownStyles as any}>
                {content || '*(empty)*'}
              </Markdown>
            </ScrollView>)}
        </View>)}
    </View>);
}
export default function SkillsScreen() {
    const { agents, projects, handleStartSkillBuilderMode } = useApp();
    const navigation = useNavigation<any>();
    const visibleProjects = useMemo(() => (projects || []).filter((p: any) => p?.id), [projects]);
    const [activeProjectId, setActiveProjectId] = useState(visibleProjects[0]?.id || null);
    // null = follow the default reference agent; otherwise the user-picked agent
    // whose overrides + context this screen is inspecting.
    const [selectedAgentId, setSelectedAgentId] = useState<any>(null);
    const [skills, setSkills] = useState<any[]>([]);
    // Built-in (default) + shared (global) skills catalog — the same list the
    // web Settings → Global Skills page shows. Kept reachable on mobile so the
    // project/global split doesn't hide built-in/shared skills entirely.
    const [globalSkills, setGlobalSkills] = useState<any[]>([]);
    const [context, setContext] = useState<any>({});
    const [overrides, setOverrides] = useState<any[]>([]);
    const [loadingSkills, setLoadingSkills] = useState(false);
    const [loadingContext, setLoadingContext] = useState(false);
    useEffect(() => {
        if (!activeProjectId && visibleProjects[0]?.id)
            setActiveProjectId(visibleProjects[0].id);
    }, [activeProjectId, visibleProjects]);
    // Every active agent in the selected project, in a stable order.
    const projectAgents = useMemo(() => (agents || []).filter((a: any) => a.projectId === activeProjectId && a.active !== false), [agents, activeProjectId]);
    // Default pick: a non-helper agent, else the first in the project.
    const referenceAgent = useMemo(() => {
        if (!activeProjectId)
            return null;
        return projectAgents.find((a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs') || projectAgents[0] || null;
    }, [projectAgents, activeProjectId]);
    // Skill Builder is a dev-agent mode; only offer "Build a skill" when the
    // project has a non-helper agent to run it on.
    const hasDevAgent = useMemo(() => projectAgents.some((a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs'), [projectAgents]);
    // Agent in focus: explicit selection when still in this project, else the default.
    const activeAgent = useMemo(() => {
        if (selectedAgentId) {
            const picked = projectAgents.find((a: any) => a.id === selectedAgentId);
            if (picked)
                return picked;
        }
        return referenceAgent;
    }, [selectedAgentId, projectAgents, referenceAgent]);
    const referenceAgentId = activeAgent?.id || null;
    // Reset the agent selection when the project changes so a stale id from a
    // previously-viewed project does not leak through.
    useEffect(() => {
        setSelectedAgentId(null);
    }, [activeProjectId]);
    const startSkillBuilder = useCallback(async () => {
        if (!activeProjectId || !handleStartSkillBuilderMode)
            return;
        try {
            await handleStartSkillBuilderMode(activeProjectId);
            navigation.navigate('Chat');
        }
        catch (err: any) {
            console.error('Failed to start Skill Builder session:', err);
        }
    }, [activeProjectId, handleStartSkillBuilderMode, navigation]);
    useEffect(() => {
        if (!activeProjectId)
            return;
        setLoadingSkills(true);
        api.getProjectSkills(activeProjectId)
            .then(setSkills)
            .catch(() => setSkills([]))
            .finally(() => setLoadingSkills(false));
        // The global catalog (built-in + shared) is project-independent.
        api.getGlobalSkills()
            .then((rows: any) => setGlobalSkills(Array.isArray(rows) ? rows : []))
            .catch(() => setGlobalSkills([]));
        if (!referenceAgentId) {
            setOverrides([]);
            setContext({});
            setLoadingContext(false);
            return;
        }
        setLoadingContext(true);
        api.getContext(referenceAgentId)
            .then(setContext)
            .catch(() => setContext({}))
            .finally(() => setLoadingContext(false));
        api.getSkillOverrides(referenceAgentId)
            .then(setOverrides)
            .catch(() => setOverrides([]));
    }, [activeProjectId, referenceAgentId]);
    const handleToggle = useCallback(async (skillId: any, enabled: any) => {
        if (!referenceAgentId)
            return;
        try {
            await api.toggleSkill(referenceAgentId, skillId, enabled);
            setOverrides((prev: any) => {
                const existing = prev.findIndex((o: any) => o.skill_id === skillId);
                if (existing >= 0) {
                    const updated = [...prev];
                    updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
                    return updated;
                }
                return [
                    ...prev,
                    { agent_id: referenceAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
                ];
            });
        }
        catch (err: any) {
            console.error('Failed to toggle skill:', err);
        }
    }, [referenceAgentId]);
    const handleUninstall = useCallback(async (skillId: any, source: any) => {
        if (source !== 'project')
            return;
        try {
            if (!activeProjectId)
                return;
            await api.uninstallSkill(activeProjectId, skillId);
            setSkills((prev: any) => prev.filter((s: any) => s.id !== skillId));
        }
        catch (err: any) {
            console.error('Failed to uninstall:', err);
        }
    }, [activeProjectId]);
    const handleContextSaved = (filename: any, newContent: any) => {
        setContext((prev: any) => ({ ...prev, [filename]: newContent }));
    };
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.pageTitle}>Skills & Context</Text>

        {/* Project selector — multi-project users pick which project's skills to manage */}
        {visibleProjects.length > 1 ? (<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agentTabs} contentContainerStyle={styles.agentTabsContent} accessibilityLabel="Select project">
            {visibleProjects.map((project: any) => (<TouchableOpacity key={project.id} style={[styles.agentTab, activeProjectId === project.id && styles.agentTabActive]} onPress={() => setActiveProjectId(project.id)}>
                <View style={[styles.tabDot, { backgroundColor: project.color || colors.gray500 }]}/>
                <Text style={[styles.agentTabText, activeProjectId === project.id && styles.agentTabTextActive]}>
                  {project.name || project.id}
                </Text>
              </TouchableOpacity>))}
          </ScrollView>) : null}

        {/* Agent selector — per-agent skill overrides + context are inspected one agent at a time */}
        {projectAgents.length > 1 ? (<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agentTabs} contentContainerStyle={styles.agentTabsContent} accessibilityLabel="Select agent for overrides">
            {projectAgents.map((agent: any) => (<TouchableOpacity key={agent.id} style={[styles.agentTab, referenceAgentId === agent.id && styles.agentTabActive]} onPress={() => setSelectedAgentId(agent.id)}>
                <View style={[styles.tabDot, { backgroundColor: agent.color || colors.gray500 }]}/>
                <Text style={[styles.agentTabText, referenceAgentId === agent.id && styles.agentTabTextActive]}>
                  {agent.name}
                </Text>
              </TouchableOpacity>))}
          </ScrollView>) : null}

        {/* Project skills — gated on the PROJECT only (project-owned), so an
            agentless project with skills still shows them. The per-agent toggle
            is a no-op without an agent, and editing/inspect reads project-owned. */}
        {activeProjectId ? (<View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Skills</Text>
              <Text style={styles.sectionCount}>({skills.length} total)</Text>
              {handleStartSkillBuilderMode && hasDevAgent ? (<TouchableOpacity style={styles.buildSkillButton} onPress={startSkillBuilder} accessibilityLabel="Build a skill">
                  <Text style={styles.buildSkillButtonText}>+ Build a skill</Text>
                </TouchableOpacity>) : null}
            </View>
            {loadingSkills ? (<ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 20 }}/>) : skills.length === 0 ? (<View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No skills found</Text>
                <Text style={styles.emptyHint}>
                  Use Build a skill or add files under skills/ in the project workspace
                </Text>
              </View>) : (<View style={styles.cardList}>
                {skills.map((skill: any) => (<SkillCard key={skill.id} skill={skill} agentId={referenceAgentId} projectId={activeProjectId} overrides={overrides} onToggle={referenceAgentId ? handleToggle : undefined} onUninstall={handleUninstall} isInstalled/>))}
              </View>)}
          </View>) : null}

        {/* Context Files — needs a reference agent (workspace identity). */}
        {activeProjectId && activeAgent ? (<View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Context Files</Text>
              <Text style={styles.sectionCount}>(workspace identity)</Text>
            </View>
            {loadingContext ? (<ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 20 }}/>) : Object.keys(context).length === 0 ? (<View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No context files found</Text>
                <Text style={styles.emptyHint}>
                  Add .md files to {activeAgent.workspace}/
                </Text>
              </View>) : (<View style={styles.cardList}>
                {Object.entries(context).map(([filename, content]: any) => (<ContextFilePanel key={filename} filename={filename} content={content} agentId={referenceAgentId} onSaved={handleContextSaved}/>))}
              </View>)}
          </View>) : null}

        {/* Built-in & Shared skills — the global catalog (project-independent), so
            built-in/shared skills stay inspectable/toggleable on mobile after the
            project/global split. Shown whenever a project is selected (an agent
            is only needed for the per-agent enable/disable toggle). */}
        {activeProjectId && globalSkills.length > 0 ? (<View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Built-in &amp; Shared</Text>
              <Text style={styles.sectionCount}>({globalSkills.length})</Text>
            </View>
            <View style={styles.cardList}>
              {globalSkills.map((skill: any) => (<SkillCard key={`global-${skill.id}`} skill={skill} agentId={referenceAgentId} overrides={overrides} onToggle={referenceAgentId ? handleToggle : undefined} isInstalled/>))}
            </View>
          </View>) : null}
      </ScrollView>
    </SafeAreaView>);
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
        marginBottom: 16,
    },
    mainTabs: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.gray700,
        marginBottom: 16,
        gap: 4,
    },
    mainTab: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
        marginBottom: -1,
    },
    mainTabActive: {
        borderBottomColor: colors.indigo500,
    },
    mainTabText: {
        fontSize: 14,
        fontWeight: '500',
        color: colors.gray400,
    },
    mainTabTextActive: {
        color: colors.white,
    },
    agentTabs: {
        marginBottom: 16,
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
    sectionSubtitle: {
        fontSize: 11,
        fontWeight: '600',
        color: colors.gray500,
        textTransform: 'uppercase',
        marginBottom: 6,
    },
    buildSkillButton: {
        marginLeft: 'auto',
        backgroundColor: colors.indigo600,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
    },
    buildSkillButtonText: {
        color: colors.white,
        fontSize: 12,
        fontWeight: '600',
    },
    cardList: {
        gap: 8,
    },
    card: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        overflow: 'hidden',
    },
    cardDisabled: {
        opacity: 0.5,
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
    cardHeaderActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 8,
    },
    cardTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
    },
    cardTitle: {
        fontSize: 14,
        fontWeight: '500',
        color: colors.gray100,
        maxWidth: 180,
    },
    cardDescription: {
        fontSize: 12,
        color: colors.gray400,
        marginTop: 4,
    },
    expandIcon: {
        fontSize: 12,
        color: colors.gray500,
        marginLeft: 4,
    },
    iconButton: {
        paddingHorizontal: 4,
        paddingVertical: 4,
    },
    toggleText: {
        fontSize: 11,
        fontWeight: '500',
        color: colors.gray500,
    },
    toggleTextActive: {
        color: colors.emerald400,
    },
    trashText: {
        fontSize: 14,
    },
    cardBody: {
        borderTopWidth: 1,
        borderTopColor: colors.gray700,
        padding: 14,
    },
    cardScroll: {
        maxHeight: 300,
    },
    categoryBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    categoryBadgeText: {
        fontSize: 10,
        fontWeight: '500',
    },
    installCount: {
        fontSize: 10,
        color: colors.gray500,
    },
    installButton: {
        backgroundColor: colors.indigo600,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
    },
    installButtonDisabled: {
        backgroundColor: colors.gray700,
    },
    installButtonText: {
        fontSize: 12,
        color: colors.white,
        fontWeight: '500',
    },
    installButtonTextDisabled: {
        color: colors.gray500,
    },
    metaText: {
        fontSize: 11,
        color: colors.gray500,
        marginTop: 8,
    },
    searchRow: {
        marginBottom: 10,
    },
    searchInput: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: colors.gray100,
        fontSize: 14,
    },
    categoryRow: {
        marginBottom: 10,
        marginHorizontal: -4,
    },
    categoryRowContent: {
        gap: 6,
        paddingHorizontal: 4,
    },
    categoryPill: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 16,
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    categoryPillActive: {
        backgroundColor: colors.indigo600,
        borderColor: colors.indigo600,
    },
    categoryPillText: {
        fontSize: 12,
        color: colors.gray400,
        fontWeight: '500',
    },
    categoryPillTextActive: {
        color: colors.white,
    },
    importButton: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 12,
        alignItems: 'center',
        marginBottom: 16,
    },
    importButtonText: {
        fontSize: 13,
        color: colors.gray300,
        fontWeight: '500',
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: colors.black60,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    modalContent: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        padding: 20,
        width: '100%',
        maxWidth: 500,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.white,
    },
    modalClose: {
        fontSize: 18,
        color: colors.gray400,
        paddingHorizontal: 6,
    },
    modalHint: {
        fontSize: 12,
        color: colors.gray400,
        marginBottom: 12,
    },
    modalInput: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: colors.gray100,
        fontSize: 13,
        marginBottom: 12,
    },
    modalError: {
        fontSize: 12,
        color: colors.red400,
        marginBottom: 12,
    },
    modalActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    modalButtonSecondary: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    modalButtonSecondaryText: {
        fontSize: 14,
        color: colors.gray400,
    },
    modalButtonPrimary: {
        backgroundColor: colors.indigo600,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        minWidth: 80,
        alignItems: 'center',
    },
    modalButtonDisabled: {
        opacity: 0.5,
    },
    modalButtonPrimaryText: {
        fontSize: 14,
        color: colors.white,
        fontWeight: '500',
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
    },
});
