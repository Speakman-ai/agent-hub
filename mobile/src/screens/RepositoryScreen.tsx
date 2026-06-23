import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativePrTime } from '../utils/prFormatting';
import { splitUnifiedDiff } from '../utils/commitDiff';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
function shortSha(sha: any) {
    return (sha || '').slice(0, 8);
}
function CommitDetailView({ projectId, sha, onBack, onOpenCommit }: any) {
    const [detail, setDetail] = useState<any>(null);
    const [error, setError] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        setDetail(null);
        setError(null);
        setLoading(true);
        api
            .getGitHostCommitDetail(projectId, sha)
            .then(setDetail)
            .catch((err: any) => setError(err?.message || 'Failed to load commit'))
            .finally(() => setLoading(false));
    }, [projectId, sha]);
    const files = detail ? splitUnifiedDiff(detail.patch) : [];
    return (<View style={detailStyles.wrap}>
      <TouchableOpacity onPress={onBack}>
        <Text style={detailStyles.back}>{'← Commits'}</Text>
      </TouchableOpacity>
      {loading && <ActivityIndicator color={colors.gray400} style={{ marginTop: 16 }}/>}
      {error && <Text style={detailStyles.error}>{error}</Text>}
      {detail && (<>
          <Text style={detailStyles.subject}>{detail.subject}</Text>
          {detail.body ? <Text style={detailStyles.body}>{detail.body}</Text> : null}
          <Text style={detailStyles.meta}>
            {detail.author} · {relativePrTime(detail.date)} · {shortSha(detail.sha)}
          </Text>
          {(detail.parents || []).map((p: any) => (<TouchableOpacity key={p} onPress={() => onOpenCommit(p)}>
              <Text style={detailStyles.parent}>parent {shortSha(p)}</Text>
            </TouchableOpacity>))}
          {files.map((section: any, i: any) => (<View key={`${section.filename}-${i}`} style={detailStyles.fileBlock}>
              <Text style={detailStyles.fileName}>
                {section.filename} (+{section.additions} −{section.deletions})
              </Text>
              {section.isBinary ? (<Text style={detailStyles.binary}>Binary file</Text>) : (<ScrollView horizontal nestedScrollEnabled>
                  <Text style={detailStyles.diffText}>{section.lines.join('\n')}</Text>
                </ScrollView>)}
            </View>))}
          {detail.patchTruncated && (<Text style={detailStyles.truncated}>Diff truncated at 1 MiB.</Text>)}
        </>)}
    </View>);
}
export default function RepositoryScreen({ route, navigation }: any) {
    const { projectId, project: routeProject } = route.params || {};
    const project = routeProject;
    const [tab, setTab] = useState('commits');
    const [branchData, setBranchData] = useState<any>(null);
    const [selectedBranch, setSelectedBranch] = useState('');
    const [commits, setCommits] = useState<any[]>([]);
    const [commitSha, setCommitSha] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<any>(null);
    const refresh = useCallback(async (branch?: any) => {
        if (!projectId)
            return;
        setLoading(true);
        setError(null);
        try {
            const branches = await api.getGitHostBranches(projectId);
            setBranchData(branches);
            const target = branch || branches.defaultBranch || branches.branches?.[0]?.name || '';
            setSelectedBranch(target);
            const data = await api.getGitHostCommits(projectId, { branch: target || undefined });
            setCommits(data?.commits || []);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to load repository');
        }
        finally {
            setLoading(false);
        }
    }, [projectId]);
    useEffect(() => {
        if (project?.gitHost !== 'agenthub')
            return;
        refresh();
    }, [refresh, project?.gitHost]);
    if (project?.gitHost !== 'agenthub') {
        return (<SafeAreaView style={styles.screen} edges={['top']}>
        <ProjectScreenHeader title="Repository" project={project} onBack={() => navigation.goBack()}/>
        <Text style={styles.empty}>Repository browser is only available for Agent Hub-hosted projects.</Text>
      </SafeAreaView>);
    }
    if (commitSha) {
        return (<SafeAreaView style={styles.screen} edges={['top']}>
        <ProjectScreenHeader title="Commit" project={project} onBack={() => setCommitSha(null)}/>
        <ScrollView contentContainerStyle={styles.content}>
          <CommitDetailView projectId={projectId} sha={commitSha} onBack={() => setCommitSha(null)} onOpenCommit={setCommitSha}/>
        </ScrollView>
      </SafeAreaView>);
    }
    const branches = branchData?.branches || [];
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Repository" project={project} onBack={() => navigation.goBack()}/>
      <View style={styles.tabs}>
        {['commits', 'branches'].map((t: any) => (<TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'commits' ? 'Commits' : 'Branches'}
            </Text>
          </TouchableOpacity>))}
        <TouchableOpacity onPress={() => refresh(selectedBranch)} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {loading && <ActivityIndicator color={colors.gray400}/>}
        {error && <Text style={styles.error}>{error}</Text>}

        {tab === 'commits' && !loading && (<>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.branchPicker}>
              {branches.map((b: any) => {
                const name = b.name || b;
                const active = name === selectedBranch;
                return (<TouchableOpacity key={name} style={[styles.branchChip, active && styles.branchChipActive]} onPress={() => refresh(name)}>
                    <Text style={[styles.branchChipText, active && styles.branchChipTextActive]}>
                      {name}
                    </Text>
                  </TouchableOpacity>);
            })}
            </ScrollView>
            {commits.map((commit: any) => (<TouchableOpacity key={commit.sha} style={styles.commitRow} onPress={() => setCommitSha(commit.sha)}>
                <Text style={styles.commitSubject} numberOfLines={1}>{commit.subject}</Text>
                <Text style={styles.commitMeta}>
                  {shortSha(commit.sha)} · {commit.author} · {relativePrTime(commit.date)}
                </Text>
              </TouchableOpacity>))}
            {commits.length === 0 && !error && (<Text style={styles.empty}>No commits on this branch.</Text>)}
          </>)}

        {tab === 'branches' && !loading && (<>
            {branches.map((b: any) => {
                const name = b.name || b;
                const isDefault = name === branchData?.defaultBranch;
                return (<View key={name} style={styles.branchRow}>
                  <Text style={styles.branchName}>
                    {name}{isDefault ? ' (default)' : ''}
                  </Text>
                  {b.ahead != null && (<Text style={styles.branchMeta}>
                      ↑{b.ahead} ↓{b.behind}
                    </Text>)}
                </View>);
            })}
            {branches.length === 0 && !error && (<Text style={styles.empty}>No branches found.</Text>)}
          </>)}
      </ScrollView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.gray950 },
    content: { padding: 16, paddingBottom: 32 },
    tabs: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.gray800, paddingBottom: 8 },
    tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
    tabActive: { backgroundColor: colors.gray800 },
    tabText: { fontSize: 13, color: colors.gray500 },
    tabTextActive: { color: colors.white, fontWeight: '600' },
    refreshBtn: { marginLeft: 'auto' },
    refreshText: { fontSize: 12, color: colors.blue400 },
    branchPicker: { marginBottom: 12, maxHeight: 40 },
    branchChip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        marginRight: 8,
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    branchChipActive: { borderColor: colors.emerald400, backgroundColor: colors.emerald800_50 },
    branchChipText: { fontSize: 12, color: colors.gray400, fontFamily: 'monospace' },
    branchChipTextActive: { color: colors.emerald400 },
    commitRow: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    commitSubject: { fontSize: 14, color: colors.gray200, fontWeight: '500' },
    commitMeta: { fontSize: 11, color: colors.gray500, marginTop: 4, fontFamily: 'monospace' },
    branchRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    branchName: { fontSize: 14, color: colors.gray300, fontFamily: 'monospace' },
    branchMeta: { fontSize: 12, color: colors.gray500 },
    empty: { fontSize: 14, color: colors.gray500, padding: 16 },
    error: { fontSize: 13, color: colors.red400, marginBottom: 8 },
});
const detailStyles = StyleSheet.create({
    wrap: { paddingBottom: 24 },
    back: { fontSize: 14, color: colors.gray400, marginBottom: 12 },
    error: { color: colors.red400, fontSize: 13 },
    subject: { fontSize: 16, fontWeight: '600', color: colors.white, marginBottom: 8 },
    body: { fontSize: 13, color: colors.gray400, marginBottom: 8 },
    meta: { fontSize: 12, color: colors.gray500, marginBottom: 12 },
    parent: { fontSize: 12, color: colors.blue400, marginBottom: 4 },
    fileBlock: {
        marginTop: 12,
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    fileName: { fontSize: 12, color: colors.gray300, fontFamily: 'monospace', marginBottom: 6 },
    diffText: { fontSize: 10, color: colors.gray400, fontFamily: 'monospace' },
    binary: { fontSize: 12, color: colors.gray500, fontStyle: 'italic' },
    truncated: { fontSize: 11, color: colors.amber400, marginTop: 8 },
});
