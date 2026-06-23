import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Linking, Platform, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
const mdStyles = {
    body: { color: colors.gray300, fontSize: 14 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    heading1: { color: colors.white, fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
    heading2: { color: colors.white, fontSize: 17, fontWeight: 'bold', marginBottom: 6 },
    heading3: { color: colors.gray200, fontSize: 15, fontWeight: '600', marginBottom: 4 },
    bullet_list: { marginBottom: 8 },
    list_item: { marginBottom: 4 },
    link: { color: colors.emerald400 },
    strong: { color: colors.white },
};
function formatReleaseDate(iso: any) {
    if (!iso)
        return null;
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }
    catch {
        return null;
    }
}
function buildMarkdown(selected: any) {
    if (!selected)
        return '';
    const lines = [];
    if (selected.summary) {
        lines.push(selected.summary, '');
    }
    if (!selected.sections?.length) {
        lines.push('_No user-facing highlights were recorded for this release._');
    }
    else {
        for (const section of selected.sections) {
            lines.push(`## ${section.title}`, '');
            for (const item of section.items || []) {
                lines.push(`- ${item.text}`);
            }
            lines.push('');
        }
    }
    return lines.join('\n');
}
export default function ReleasesScreen() {
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [pickedVersion, setPickedVersion] = useState<any>(null);
    const load = useCallback(async (refresh: any = false) => {
        setLoading(true);
        setError(null);
        try {
            const json = await api.getReleases({ version: pickedVersion, refresh });
            setData(json);
        }
        catch (err: any) {
            setError(err.message || String(err));
        }
        finally {
            setLoading(false);
        }
    }, [pickedVersion]);
    useEffect(() => {
        load(false);
    }, [load]);
    const selected = data?.selected ?? null;
    const list = data?.releases ?? [];
    const headerRight = (<TouchableOpacity style={styles.refreshBtn} onPress={() => load(true)} disabled={loading}>
      {loading ? (<ActivityIndicator size="small" color={colors.gray300}/>) : (<Text style={styles.refreshText}>Refresh</Text>)}
    </TouchableOpacity>);
    return (<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ProjectScreenHeader title="What's new" right={headerRight}/>

      {data?.currentVersion ? (<Text style={styles.subtitle}>
          You're on v{data.currentVersion}
        </Text>) : null}

      {error ? (<View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>) : null}

      <View style={styles.body}>
        <ScrollView style={styles.versionList} contentContainerStyle={styles.versionListContent}>
          {loading && list.length === 0 ? (<Text style={styles.muted}>Loading releases…</Text>) : list.length === 0 ? (<Text style={styles.muted}>No releases found.</Text>) : (list.map((r: any) => {
            const active = selected?.version === r.version;
            const isCurrent = data?.currentVersion === r.version;
            return (<TouchableOpacity key={r.tag || r.version} style={[styles.versionItem, active && styles.versionItemActive]} onPress={() => setPickedVersion(r.version)}>
                  <View style={styles.versionRow}>
                    <Text style={[styles.versionLabel, active && styles.versionLabelActive]}>
                      v{r.version}
                    </Text>
                    {isCurrent ? (<View style={styles.currentBadge}>
                        <Text style={styles.currentBadgeText}>current</Text>
                      </View>) : null}
                  </View>
                  {r.summary ? (<Text style={styles.versionSummary} numberOfLines={2}>
                      {r.summary}
                    </Text>) : null}
                </TouchableOpacity>);
        }))}
        </ScrollView>

        <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent}>
          {!selected && !loading ? (<Text style={styles.muted}>Select a version to see what changed.</Text>) : selected ? (<>
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>v{selected.version}</Text>
                {data?.currentVersion === selected.version ? (<View style={styles.yourVersionBadge}>
                    <Text style={styles.yourVersionText}>Your version</Text>
                  </View>) : null}
              </View>
              {formatReleaseDate(selected.publishedAt) ? (<Text style={styles.releaseDate}>
                  Released {formatReleaseDate(selected.publishedAt)}
                </Text>) : null}
              <Markdown style={mdStyles as any}>{buildMarkdown(selected)}</Markdown>
              {selected.url ? (<TouchableOpacity onPress={() => Linking.openURL(selected.url)}>
                  <Text style={styles.githubLink}>View on GitHub →</Text>
                </TouchableOpacity>) : null}
            </>) : (<ActivityIndicator color={colors.gray500}/>)}
        </ScrollView>
      </View>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.gray950 },
    subtitle: {
        fontSize: 12,
        color: colors.gray500,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    refreshBtn: {
        marginLeft: 'auto',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.gray700,
        minWidth: 72,
        alignItems: 'center',
    },
    refreshText: { color: colors.gray300, fontSize: 12 },
    errorBox: {
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.red900_50,
        borderWidth: 1,
        borderColor: colors.red600,
    },
    errorText: { color: colors.red400, fontSize: 13 },
    body: { flex: 1, flexDirection: 'row' },
    versionList: {
        width: 130,
        borderRightWidth: 1,
        borderRightColor: colors.gray800,
    },
    versionListContent: { paddingVertical: 8 },
    versionItem: { paddingHorizontal: 12, paddingVertical: 10 },
    versionItemActive: { backgroundColor: colors.gray800 },
    versionRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    versionLabel: { fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.gray400 },
    versionLabelActive: { color: colors.white },
    currentBadge: {
        backgroundColor: colors.emerald900_50,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 3,
    },
    currentBadgeText: { fontSize: 9, color: colors.emerald400 },
    versionSummary: { fontSize: 10, color: colors.gray600, marginTop: 4 },
    detail: { flex: 1 },
    detailContent: { padding: 16, paddingBottom: 32 },
    detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    detailTitle: {
        fontSize: 22,
        fontWeight: '600',
        color: colors.white,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    yourVersionBadge: {
        backgroundColor: colors.emerald900_40,
        borderWidth: 1,
        borderColor: colors.emerald800_50,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 12,
    },
    yourVersionText: { fontSize: 11, color: colors.emerald400 },
    releaseDate: { fontSize: 11, color: colors.gray500, marginBottom: 12 },
    githubLink: { color: colors.emerald400, fontSize: 14, marginTop: 16 },
    muted: { color: colors.gray500, fontSize: 13, padding: 16 },
});
