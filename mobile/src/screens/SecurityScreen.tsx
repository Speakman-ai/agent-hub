import React, { useState, useEffect, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Linking, Alert, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { SidebarContext } from '../context/SidebarContext';
import { sortFindings, countBySeverity } from '../utils/securityFindings';
const SEVERITY_COLOR: Record<string, any> = {
    critical: colors.red500,
    high: colors.red400,
    medium: colors.amber400,
    low: colors.gray500,
    unknown: colors.gray500,
};
const STATUS_LABEL: Record<string, any> = { open: 'Open', fixed: 'Fixed', dismissed: 'Dismissed' };
// Severity categories shown in the per-severity count breakdown, most severe first.
const SEVERITY_ORDER: { key: string; label: string }[] = [
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
    { key: 'unknown', label: 'Unknown' },
];
// Server lifecycle statuses → the single-value `status` query the findings
// endpoint accepts (omit for "All").
const STATUS_FILTERS = [
    { key: 'open', label: 'Open', status: 'open' },
    { key: 'fixed', label: 'Fixed', status: 'fixed' },
    { key: 'dismissed', label: 'Dismissed', status: 'dismissed' },
    { key: 'all', label: 'All', status: undefined },
];
function relativeTime(ms: any) {
    if (!ms)
        return '';
    const diffMins = Math.floor((Date.now() - ms) / 60000);
    if (diffMins < 1)
        return 'just now';
    if (diffMins < 60)
        return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24)
        return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 30)
        return `${diffDays}d ago`;
    return new Date(ms).toLocaleDateString();
}
function FindingCard({ item, projectId, onDismissed, onFixed }: any) {
    const severityColor = SEVERITY_COLOR[item.severity] || colors.gray500;
    const [dismissing, setDismissing] = useState(false);
    const [fixing, setFixing] = useState(false);
    // Open (or refresh) a bump PR for this finding. Single tap — the server
    // action is idempotent (re-tapping refreshes the same branch/PR).
    const handleFix = async () => {
        if (fixing)
            return;
        setFixing(true);
        try {
            const result: any = await api.fixSecurityFinding(projectId, item.id);
            const opened = result?.opened?.[0];
            const skipped = result?.skipped?.[0];
            if (opened) {
                const verb = opened.prCreated ? 'Opened' : 'Updated';
                Alert.alert('Fix PR', `${verb} PR #${opened.prNumber}: bump ${opened.packageName} to ${opened.toVersion}.`);
            }
            else if (skipped) {
                const why = skipped.reason === 'lockfile_missing'
                    ? 'lockfile not found'
                    : skipped.reason === 'lockfile_unchanged'
                        ? 'already at the fixed version'
                        : skipped.detail || 'could not apply the bump';
                Alert.alert('No PR opened', `${item.package_name}: ${why}`);
            }
            else {
                Alert.alert('No PR opened', `No fixable change for ${item.package_name}.`);
            }
            onFixed?.();
        }
        catch (err: any) {
            Alert.alert('Fix failed', err?.message || 'Failed to open fix PR');
        }
        finally {
            setFixing(false);
        }
    };
    const performDismiss = async () => {
        if (dismissing)
            return;
        setDismissing(true);
        try {
            await api.dismissSecurityFinding(projectId, item.id);
            onDismissed?.(item.id);
        }
        catch (err: any) {
            Alert.alert('Could not dismiss', err?.message || 'Failed to dismiss finding');
            setDismissing(false);
        }
    };
    const handleDismiss = () => {
        if (dismissing)
            return;
        Alert.alert('Dismiss finding?', 'This suppresses the advisory on future re-scans.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Dismiss', style: 'destructive', onPress: performDismiss },
        ]);
    };
    return (<View style={styles.card} testID="security-finding-card">
      <View style={styles.badgeRow}>
        <View style={[styles.severityBadge, { borderColor: severityColor }]}>
          <Text style={[styles.severityText, { color: severityColor }]}>{item.severity}</Text>
        </View>
        <Text style={styles.pkg} testID="finding-package">
          {item.package_name}@{item.package_version}
        </Text>
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>{STATUS_LABEL[item.status] || item.status}</Text>
        </View>
        <Text style={styles.time}>{relativeTime(item.last_seen_at)}</Text>
      </View>

      {item.summary ? <Text style={styles.summary}>{item.summary}</Text> : null}

      <View style={styles.metaRow}>
        {item.advisory_url ? (<TouchableOpacity testID="advisory-link" onPress={() => Linking.openURL(item.advisory_url).catch(() => { })}>
            <Text style={styles.advisoryLink}>{item.advisory_id || 'advisory'}</Text>
          </TouchableOpacity>) : (<Text style={styles.advisoryPlain}>{item.advisory_id || 'advisory'}</Text>)}
        <Text style={styles.fixText} testID="finding-fix">
          {item.fixed_version ? `Fix: upgrade to ${item.fixed_version}` : 'No fix published yet'}
        </Text>
      </View>

      <View style={styles.footerRow}>
        <Text style={styles.manifest}>{item.manifest_path}</Text>
        {item.status === 'open' ? (<View style={styles.footerActions}>
            {item.fixed_version ? (<TouchableOpacity onPress={handleFix} disabled={fixing} testID="finding-fix-button" style={[styles.fixButton, fixing && styles.dismissButtonDisabled]}>
                <Text style={styles.fixButtonText}>{fixing ? 'Opening PR…' : 'Fix'}</Text>
              </TouchableOpacity>) : null}
            <TouchableOpacity onPress={handleDismiss} disabled={dismissing} testID="dismiss-finding" style={[styles.dismissButton, dismissing && styles.dismissButtonDisabled]}>
              <Text style={styles.dismissText}>{dismissing ? 'Dismissing…' : 'Dismiss'}</Text>
            </TouchableOpacity>
          </View>) : null}
      </View>
    </View>);
}
export default function SecurityScreen({ route }: any) {
    const { projects, kanbanRefreshKey, refreshSecurityOpenCounts } = useApp();
    const { openSidebar } = useContext(SidebarContext);
    const projectId = route?.params?.projectId || projects?.[0]?.id;
    const project = projects?.find((p: any) => p.id === projectId);
    const [findings, setFindings] = useState<any[]>([]);
    const [statusFilter, setStatusFilter] = useState('open');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<any>(null);
    const activeStatus = STATUS_FILTERS.find((f: any) => f.key === statusFilter) || STATUS_FILTERS[0];
    const load = useCallback(async () => {
        if (!projectId)
            return;
        setLoading(true);
        setError(null);
        try {
            const data = await api.getSecurityFindings(projectId, activeStatus.status);
            setFindings(sortFindings(Array.isArray(data?.findings) ? data.findings : []));
            // Keep the drawer badge in sync with the freshly-fetched counts.
            if (data?.openCounts)
                refreshSecurityOpenCounts(projectId);
        }
        catch (err: any) {
            setError(err.message || 'Failed to load security findings');
        }
        finally {
            setLoading(false);
        }
    }, [projectId, activeStatus.status, refreshSecurityOpenCounts]);
    useEffect(() => {
        load();
    }, [load]);
    // A scan's only WS signal is kanban_update (AppContext bumps kanbanRefreshKey);
    // re-fetch so the list stays live without a manual pull-to-refresh.
    useEffect(() => {
        if (kanbanRefreshKey)
            load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kanbanRefreshKey]);
    const handleDismissed = useCallback((id: any) => {
        // Optimistically drop the row for snappy feedback in the Open view, then
        // reload honouring the active filter so the list is correct: under "All"
        // (or "Dismissed") the advisory must REMAIN visible as status=dismissed,
        // not vanish. load() also refreshes the counts — the dismiss endpoint
        // emits no WebSocket event of its own.
        setFindings((prev: any) => prev.filter((f: any) => f.id !== id));
        load();
    }, [load]);
    // Rescan / Autofix share one in-flight flag (both POST the same scan
    // endpoint). `scanMode` tracks which is running for per-button labels.
    const [scanMode, setScanMode] = useState<any>(null); // null | 'rescan' | 'autofix'
    const runScan = useCallback(async (mode: any) => {
        if (scanMode || !projectId)
            return;
        setScanMode(mode);
        try {
            const result: any = await api.runSecurityScan(projectId, { autoPr: mode === 'autofix' });
            if (mode === 'autofix') {
                const opened = result?.autoPr?.opened?.length ?? 0;
                Alert.alert('Autofix', opened > 0
                    ? `Opened ${opened} bump PR${opened === 1 ? '' : 's'} for fixable findings.`
                    : 'No fixable findings to open PRs for.');
            }
            await load();
        }
        catch (err: any) {
            Alert.alert(mode === 'autofix' ? 'Autofix failed' : 'Rescan failed', err?.message || 'Scan request failed');
        }
        finally {
            setScanMode(null);
        }
    }, [scanMode, projectId, load]);
    const renderItem = ({ item }: any) => (<FindingCard item={item} projectId={projectId} onDismissed={handleDismissed} onFixed={load}/>);
    // Per-severity tally of the loaded list, surfaced as a breakdown row so each
    // category's size is visible at a glance (tracks the active status filter).
    const severityCounts = countBySeverity(findings);
    return (<SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Security</Text>
        {project && (<Text style={styles.projectLabel} numberOfLines={1}>
            {project.name}
          </Text>)}
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity
          testID="security-autofix"
          onPress={() => runScan('autofix')}
          disabled={!!scanMode}
          style={[styles.actionButton, styles.autofixButton, !!scanMode && styles.actionDisabled]}
        >
          <Text style={[styles.actionText, styles.autofixText]}>
            {scanMode === 'autofix' ? 'Fixing…' : 'Autofix'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="security-rescan"
          onPress={() => runScan('rescan')}
          disabled={!!scanMode}
          style={[styles.actionButton, !!scanMode && styles.actionDisabled]}
        >
          <Text style={styles.actionText}>{scanMode === 'rescan' ? 'Scanning…' : 'Rescan'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f: any) => (<TouchableOpacity key={f.key} testID={`status-filter-${f.key}`} onPress={() => setStatusFilter(f.key)} style={[styles.filterButton, statusFilter === f.key && styles.filterButtonActive]}>
            <Text style={[styles.filterText, statusFilter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>))}
      </View>

      {severityCounts.all > 0 ? (<View style={styles.severityRow} testID="severity-breakdown">
          {SEVERITY_ORDER.filter((s) => severityCounts[s.key] > 0).map((s) => (<View key={s.key} testID={`severity-count-${s.key}`} style={[styles.severityChip, { borderColor: SEVERITY_COLOR[s.key] || colors.gray500 }]}>
              <Text style={[styles.severityChipLabel, { color: SEVERITY_COLOR[s.key] || colors.gray500 }]}>
                {s.label}
              </Text>
              <Text style={styles.severityChipCount}>{severityCounts[s.key]}</Text>
            </View>))}
        </View>) : null}

      {loading ? (<View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400}/>
        </View>) : error ? (<View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>) : findings.length === 0 ? (<View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No security findings</Text>
          <Text style={styles.emptyDesc}>
            Vulnerable dependencies appear here, most severe first.
          </Text>
        </View>) : (<FlatList data={findings} keyExtractor={(item: any) => item.id} contentContainerStyle={{ padding: 12 }} renderItem={renderItem}/>)}
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.gray950 },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: { padding: 4 },
    menuIcon: { fontSize: 22, color: colors.gray400 },
    title: { fontSize: 17, fontWeight: '600', color: colors.white, flexShrink: 1 },
    projectLabel: { marginLeft: 'auto', fontSize: 12, color: colors.gray500, maxWidth: 120 },
    actionRow: {
        flexDirection: 'row',
        paddingHorizontal: 12,
        paddingTop: 8,
        gap: 8,
    },
    actionButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: colors.gray800,
    },
    autofixButton: { backgroundColor: 'rgba(16,185,129,0.12)' },
    actionDisabled: { opacity: 0.5 },
    actionText: { fontSize: 12, color: colors.gray200, fontWeight: '600' },
    autofixText: { color: colors.emerald400 || '#6ee7b7' },
    filterRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    filterButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: colors.gray800,
    },
    filterButtonActive: { backgroundColor: colors.gray700 },
    filterText: { fontSize: 12, color: colors.gray500 },
    filterTextActive: { color: colors.gray200, fontWeight: '600' },
    severityRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: 12,
        paddingBottom: 8,
        gap: 6,
    },
    severityChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
    },
    severityChipLabel: { fontSize: 11, fontWeight: '600' },
    severityChipCount: { fontSize: 11, fontWeight: '700', color: colors.gray200 },
    centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.gray400, marginBottom: 6 },
    emptyDesc: { fontSize: 13, color: colors.gray600, textAlign: 'center', lineHeight: 18 },
    errorText: { fontSize: 13, color: colors.red400, textAlign: 'center' },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginBottom: 8,
    },
    badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    severityBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
    severityText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
    pkg: { fontSize: 13, color: colors.gray100, fontWeight: '600', fontFamily: 'monospace' },
    statusBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: colors.gray700_40,
    },
    statusText: { fontSize: 10, color: colors.gray500 },
    time: { fontSize: 11, color: colors.gray600, marginLeft: 'auto' },
    summary: { fontSize: 13, color: colors.gray300, marginTop: 8 },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 8,
    },
    advisoryLink: { fontSize: 12, color: colors.blue400 },
    advisoryPlain: { fontSize: 12, color: colors.gray500 },
    fixText: { fontSize: 12, color: colors.emerald400 },
    footerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    manifest: { fontSize: 11, color: colors.gray600, fontFamily: 'monospace', flexShrink: 1 },
    footerActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 },
    fixButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: 'rgba(16,185,129,0.5)',
        backgroundColor: 'rgba(16,185,129,0.12)',
    },
    fixButtonText: { fontSize: 12, color: colors.emerald400 || '#6ee7b7', fontWeight: '600' },
    dismissButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    dismissButtonDisabled: { opacity: 0.5 },
    dismissText: { fontSize: 12, color: colors.gray300, fontWeight: '600' },
});
