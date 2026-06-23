import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
const COLOR_OPTIONS = [
    { value: '#6366f1', label: 'Indigo' },
    { value: '#10b981', label: 'Emerald' },
    { value: '#f59e0b', label: 'Amber' },
    { value: '#ef4444', label: 'Red' },
    { value: '#8b5cf6', label: 'Purple' },
    { value: '#3b82f6', label: 'Blue' },
];
function slugifyProjectId(raw: any) {
    if (typeof raw !== 'string')
        return '';
    return raw
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}
function parseGithubRepo(input: any) {
    const trimmed = String(input || '').trim();
    if (!trimmed)
        return null;
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed))
        return trimmed;
    const m = trimmed.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    if (m)
        return `${m[1]}/${m[2]}`;
    return null;
}
function ProvisioningBanner({ info }: any) {
    if (!info)
        return null;
    const lines = [];
    if (info.jobId)
        lines.push(`Job: ${info.jobId}`);
    if (info.status)
        lines.push(`Status: ${info.status}`);
    if (info.message)
        lines.push(info.message);
    if (lines.length === 0)
        return null;
    return (<View style={styles.provisionBox}>
      <Text style={styles.provisionTitle}>Provisioning</Text>
      {lines.map((line: any) => (<Text key={line} style={styles.provisionLine}>
          {line}
        </Text>))}
    </View>);
}
export default function NewProjectScreen({ navigation }: any) {
    const { refreshProjects, refreshAgents } = useApp();
    const [name, setName] = useState('');
    const [githubRepo, setGithubRepo] = useState('');
    const [cwd, setCwd] = useState('');
    const [color, setColor] = useState(COLOR_OPTIONS[0].value);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<any>(null);
    const [createdProject, setCreatedProject] = useState<any>(null);
    const [provisioningInfo, setProvisioningInfo] = useState<any>(null);
    const slugPreview = useMemo<any>(() => slugifyProjectId(name.trim()), [name]);
    const canSubmit = name.trim().length > 0 && slugPreview.length >= 3 && !submitting;
    const handleSubmit = async () => {
        if (!canSubmit)
            return;
        setSubmitting(true);
        setError(null);
        setProvisioningInfo(null);
        try {
            const body = {
                id: slugPreview,
                name: name.trim(),
                cwd: cwd.trim() || undefined,
                color,
            };
            const project = await api.createProject(body);
            const repo = parseGithubRepo(githubRepo);
            if (repo) {
                await api.updateProject(project.id, { githubRepo: repo });
            }
            setCreatedProject({ ...project, githubRepo: repo || project.githubRepo });
            refreshProjects?.();
            refreshAgents?.();
            if (project.jobId || project.provisioning || project.wsUrl) {
                setProvisioningInfo({
                    jobId: project.jobId,
                    status: project.provisioning?.status || project.status,
                    message: project.provisioning?.message,
                    wsUrl: project.wsUrl,
                });
            }
        }
        catch (err: any) {
            const msg = err.message || 'Failed to create project';
            if (msg.includes('409')) {
                setError('A project with this id already exists — try a different name.');
            }
            else {
                setError(msg);
            }
        }
        finally {
            setSubmitting(false);
        }
    };
    const handleDone = () => {
        if (createdProject?.id) {
            navigation.navigate('Kanban', {
                projectId: createdProject.id,
                project: createdProject,
            });
        }
        else {
            navigation.goBack();
        }
    };
    return (<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ProjectScreenHeader title="New Project" onBack={() => navigation.goBack()}/>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
          {createdProject ? (<View style={styles.successBox}>
              <Text style={styles.successTitle}>Project created</Text>
              <Text style={styles.successName}>{createdProject.name}</Text>
              <Text style={styles.successId}>ID: {createdProject.id}</Text>
              {createdProject.githubRepo ? (<Text style={styles.successMeta}>GitHub: {createdProject.githubRepo}</Text>) : null}
              <ProvisioningBanner info={provisioningInfo}/>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleDone}>
                <Text style={styles.primaryBtnText}>Open Board</Text>
              </TouchableOpacity>
            </View>) : (<>
              <Text style={styles.intro}>
                Create a project with a name, optional GitHub repo, working directory, and color.
              </Text>

              {error ? (<View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>) : null}

              <Text style={styles.label}>Project name</Text>
              <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. My App" placeholderTextColor={colors.gray600} autoFocus/>
              {slugPreview ? (<Text style={styles.hint}>Project id: {slugPreview}</Text>) : null}

              <Text style={styles.label}>GitHub repo URL (optional)</Text>
              <TextInput style={styles.input} value={githubRepo} onChangeText={setGithubRepo} placeholder="owner/repo or https://github.com/owner/repo" placeholderTextColor={colors.gray600} autoCapitalize="none" autoCorrect={false}/>

              <Text style={styles.label}>Working directory (cwd)</Text>
              <TextInput style={styles.input} value={cwd} onChangeText={setCwd} placeholder="Leave blank for server default" placeholderTextColor={colors.gray600} autoCapitalize="none" autoCorrect={false}/>

              <Text style={styles.label}>Color</Text>
              <View style={styles.colorRow}>
                {COLOR_OPTIONS.map((opt: any) => (<TouchableOpacity key={opt.value} style={[
                    styles.colorSwatch,
                    { backgroundColor: opt.value },
                    color === opt.value && styles.colorSwatchActive,
                ]} onPress={() => setColor(opt.value)}/>))}
              </View>

              <TouchableOpacity style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]} onPress={handleSubmit} disabled={!canSubmit}>
                {submitting ? (<ActivityIndicator color={colors.white}/>) : (<Text style={styles.primaryBtnText}>Create Project</Text>)}
              </TouchableOpacity>
            </>)}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.gray950 },
    form: { padding: 16, paddingBottom: 40 },
    intro: { fontSize: 14, color: colors.gray400, marginBottom: 16 },
    label: { fontSize: 12, fontWeight: '600', color: colors.gray400, marginBottom: 6, marginTop: 12 },
    input: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: colors.white,
        fontSize: 14,
    },
    hint: { fontSize: 11, color: colors.gray600, marginTop: 4 },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
    colorSwatch: { width: 32, height: 32, borderRadius: 8 },
    colorSwatchActive: { borderWidth: 2, borderColor: colors.white },
    primaryBtn: {
        backgroundColor: colors.emerald500,
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 24,
    },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { color: colors.white, fontSize: 15, fontWeight: '600' },
    errorBox: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.red900_50,
        borderWidth: 1,
        borderColor: colors.red600,
        marginBottom: 8,
    },
    errorText: { color: colors.red400, fontSize: 13 },
    successBox: {
        backgroundColor: colors.gray900,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.gray800,
        padding: 20,
    },
    successTitle: { fontSize: 16, fontWeight: '600', color: colors.emerald400, marginBottom: 8 },
    successName: { fontSize: 20, fontWeight: '700', color: colors.white, marginBottom: 4 },
    successId: { fontSize: 12, color: colors.gray500, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    successMeta: { fontSize: 12, color: colors.gray400, marginTop: 4 },
    provisionBox: {
        marginTop: 16,
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.gray950,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    provisionTitle: { fontSize: 13, fontWeight: '600', color: colors.amber400, marginBottom: 6 },
    provisionLine: { fontSize: 12, color: colors.gray400, marginBottom: 2 },
});
