import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
const FRAMEWORK_LABELS: Record<string, any> = {
    next: 'Next.js',
    nuxt: 'Nuxt',
    sveltekit: 'SvelteKit',
    remix: 'Remix',
    astro: 'Astro',
    vue: 'Vue',
    angular: 'Angular',
    react: 'React',
    vanilla: 'Vanilla / static HTML',
    unknown: 'Unknown',
};
function formatLastUsed(lastUsedAt: any) {
    if (!lastUsedAt)
        return 'never used';
    const rel = relativeTime(lastUsedAt);
    return rel ? `last used ${rel}` : 'never used';
}
// Per-project retention options — mirror the web RumSettingsSection selects.
// `0` days = "platform default" (clears the override server-side).
export const BASE_RETENTION_OPTIONS: { value: number; label: string }[] = [
    { value: 0, label: 'Default' },
    { value: 7, label: '7 days' },
    { value: 14, label: '14 days' },
    { value: 30, label: '30 days' },
    { value: 60, label: '60 days' },
    { value: 90, label: '90 days' },
];
export const EXTENDED_RETENTION_OPTIONS: { value: number; label: string }[] = [
    { value: 1, label: '1 mo' },
    { value: 3, label: '3 mo' },
    { value: 6, label: '6 mo' },
    { value: 12, label: '12 mo' },
    { value: 15, label: '15 mo (max)' },
];
// Overlay one retention key onto the persisted replay config without clobbering
// sampling/quotas. Base-retention 0 clears the override (a persisted 0 fails the
// server's must-be-positive validation). Returns the `replay` object to PATCH.
// Mirrors the web handlers so both surfaces write identical shapes.
export function buildRetentionReplayPatch(currentReplay: any, key: 'retentionDays' | 'extendedRetentionMonths', value: number): Record<string, unknown> {
    const replay: Record<string, unknown> = { ...(currentReplay || {}) };
    if (key === 'retentionDays' && value <= 0)
        delete replay.retentionDays;
    else
        replay[key] = value;
    return replay;
}
export default function RumSettingsScreen({ route, navigation }: any) {
    const { projectId, project: routeProject } = route.params || {};
    const { setActiveAgentId, setActiveSessionId } = useApp();
    const project = routeProject;
    const [draft, setDraft] = useState<any>(null);
    const [draftLoading, setDraftLoading] = useState(true);
    const [draftError, setDraftError] = useState<any>(null);
    const [clients, setClients] = useState<any[]>([]);
    const [clientsLoading, setClientsLoading] = useState(true);
    const [clientsError, setClientsError] = useState<any>(null);
    const [newClientName, setNewClientName] = useState('');
    const [minting, setMinting] = useState(false);
    const [freshToken, setFreshToken] = useState<any>(null);
    const [wizardStarting, setWizardStarting] = useState(false);
    const [wizardError, setWizardError] = useState<any>(null);
    const [lastSessionId, setLastSessionId] = useState<any>(null);
    const [spawnedAgentId, setSpawnedAgentId] = useState<any>(null);
    // Per-project retention config. Seed from the route project's persisted
    // `replay` block; keep a local copy so successive saves preserve the other
    // replay keys (the route project doesn't refresh after a PATCH).
    const [replayCfg, setReplayCfg] = useState<any>(() => (project as any)?.replay || {});
    const [savingRetention, setSavingRetention] = useState(false);
    const [retentionError, setRetentionError] = useState<any>(null);
    const baseRetentionDays = typeof replayCfg?.retentionDays === 'number' ? replayCfg.retentionDays : 0;
    const extendedRetentionMonths = typeof replayCfg?.extendedRetentionMonths === 'number' ? replayCfg.extendedRetentionMonths : 15;
    const saveRetention = useCallback(async (key: 'retentionDays' | 'extendedRetentionMonths', value: number) => {
        if (!projectId || savingRetention)
            return;
        const replay = buildRetentionReplayPatch(replayCfg, key, value);
        const prev = replayCfg;
        setReplayCfg(replay);
        setSavingRetention(true);
        setRetentionError(null);
        try {
            await api.updateProject(projectId, { replay });
        }
        catch (err: any) {
            setReplayCfg(prev);
            setRetentionError(err?.message || 'Failed to save retention settings');
        }
        finally {
            setSavingRetention(false);
        }
    }, [projectId, replayCfg, savingRetention]);
    const reloadDraft = useCallback(async () => {
        if (!projectId)
            return;
        setDraftLoading(true);
        setDraftError(null);
        try {
            const res = await api.getRumSetupDraft(projectId);
            setDraft(res?.draft || null);
        }
        catch (err: any) {
            setDraftError(err?.message || 'Failed to scan project');
            setDraft(null);
        }
        finally {
            setDraftLoading(false);
        }
    }, [projectId]);
    const reloadClients = useCallback(async () => {
        if (!projectId)
            return;
        setClientsLoading(true);
        setClientsError(null);
        try {
            const res = await api.getRumClients(projectId);
            setClients(res?.clients || []);
        }
        catch (err: any) {
            setClientsError(err?.message || 'Failed to load clients');
            setClients([]);
        }
        finally {
            setClientsLoading(false);
        }
    }, [projectId]);
    useEffect(() => {
        reloadDraft();
        reloadClients();
    }, [reloadDraft, reloadClients]);
    const handleStartWizard = async () => {
        if (wizardStarting)
            return;
        setWizardStarting(true);
        setWizardError(null);
        try {
            const res = await api.startRumWizard(projectId);
            if (!res?.sessionId) {
                setWizardError('Server did not return a wizard session id');
                return;
            }
            setLastSessionId(res.sessionId);
            setSpawnedAgentId(res.agentId || null);
        }
        catch (err: any) {
            setWizardError(err?.message || 'Failed to start RUM wizard');
        }
        finally {
            setWizardStarting(false);
        }
    };
    const handleOpenWizardChat = () => {
        if (!lastSessionId)
            return;
        if (spawnedAgentId)
            setActiveAgentId(spawnedAgentId);
        setActiveSessionId(lastSessionId);
        navigation.navigate('Chat');
    };
    const handleCreateClient = async () => {
        const name = newClientName.trim();
        if (!name) {
            Alert.alert('Name required', 'Enter a label for the ingest client.');
            return;
        }
        setMinting(true);
        try {
            const res = await api.createRumClient(projectId, name);
            setFreshToken(res?.token || null);
            setNewClientName('');
            await reloadClients();
        }
        catch (err: any) {
            Alert.alert('Create failed', err?.message || 'Could not create client');
        }
        finally {
            setMinting(false);
        }
    };
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="RUM" project={project} onBack={() => navigation.goBack()}/>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>Setup draft</Text>
        <Text style={styles.hint}>Read-only repo scan — framework, injection target, CSP hits.</Text>
        {draftLoading && <ActivityIndicator color={colors.gray400}/>}
        {draftError && <Text style={styles.error}>{draftError}</Text>}
        {draft && (<View style={styles.card}>
            <Text style={styles.row}>
              Framework: {FRAMEWORK_LABELS[draft.framework] || draft.framework || '—'}
            </Text>
            <Text style={styles.row}>Injection: {draft.injectionTarget || '—'}</Text>
            <Text style={styles.row}>
              Already instrumented: {draft.alreadyInstrumented ? 'yes' : 'no'}
            </Text>
            {draft.cspHits?.length > 0 && (<Text style={styles.row}>CSP locations: {draft.cspHits.length}</Text>)}
          </View>)}
        {!draftLoading && !draftError && !draft && (<View style={styles.card}>
            <Text style={styles.row}>
              The repo scan returned no result for this project. Its workspace may be empty or
              unreadable.
            </Text>
            <TouchableOpacity style={styles.secondaryBtn} onPress={reloadDraft}>
              <Text style={styles.secondaryBtnText}>Rescan</Text>
            </TouchableOpacity>
          </View>)}

        <Text style={styles.sectionTitle}>RUM wizard</Text>
        <TouchableOpacity style={[styles.primaryBtn, wizardStarting && styles.btnDisabled]} onPress={handleStartWizard} disabled={wizardStarting}>
          <Text style={styles.primaryBtnText}>
            {wizardStarting ? 'Starting…' : lastSessionId ? 'Re-run wizard' : 'Set up RUM'}
          </Text>
        </TouchableOpacity>
        {lastSessionId && (<TouchableOpacity style={styles.secondaryBtn} onPress={handleOpenWizardChat}>
            <Text style={styles.secondaryBtnText}>Open wizard chat</Text>
          </TouchableOpacity>)}
        {wizardError && <Text style={styles.error}>{wizardError}</Text>}

        <Text style={styles.sectionTitle}>Ingest clients</Text>
        {clientsLoading && <ActivityIndicator color={colors.gray400}/>}
        {clientsError && <Text style={styles.error}>{clientsError}</Text>}
        {freshToken && (<View style={styles.tokenBox}>
            <Text style={styles.tokenLabel}>New token (copy now — shown once)</Text>
            <Text style={styles.tokenValue} selectable>{freshToken}</Text>
            <TouchableOpacity onPress={() => setFreshToken(null)}>
              <Text style={styles.link}>Dismiss</Text>
            </TouchableOpacity>
          </View>)}
        <View style={styles.createRow}>
          <TextInput style={[styles.input, { flex: 1 }]} value={newClientName} onChangeText={setNewClientName} placeholder="Client name" placeholderTextColor={colors.gray600}/>
          <TouchableOpacity style={[styles.primaryBtn, { marginTop: 0 }, minting && styles.btnDisabled]} onPress={handleCreateClient} disabled={minting}>
            <Text style={styles.primaryBtnText}>{minting ? '…' : 'Create'}</Text>
          </TouchableOpacity>
        </View>
        {clients.map((c: any) => (<View key={c.id} style={styles.clientCard}>
            <Text style={styles.clientName}>{c.name || c.id}</Text>
            <Text style={styles.clientMeta}>{formatLastUsed(c.lastUsedAt)}</Text>
          </View>))}
        {!clientsLoading && clients.length === 0 && !clientsError && (<Text style={styles.hint}>No ingest clients yet.</Text>)}

        <Text style={styles.sectionTitle}>Retention (this project)</Text>
        <Text style={styles.hint}>
          Captures live for the base window, then expire. Flag a session in the replay player
          (the Keep button) to move it to the extended tier — kept for the window below (up to 15
          months), the clock starting when you flag it.
        </Text>
        <View style={styles.card} testID="rum-retention-config">
          <Text style={styles.retentionLabel}>Base-retention window</Text>
          <Text style={styles.retentionSub}>
            Overrides the platform default. Can only shorten it, never extend past it.
          </Text>
          <View style={styles.chipRow}>
            {BASE_RETENTION_OPTIONS.map((opt) => {
              const selected = baseRetentionDays === opt.value;
              return (<TouchableOpacity key={opt.value} testID={`rum-base-retention-${opt.value}`} disabled={savingRetention} onPress={() => saveRetention('retentionDays', opt.value)} style={[styles.chip, selected && styles.chipActive, savingRetention && styles.btnDisabled]}>
                  <Text style={[styles.chipText, selected && styles.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>);
            })}
          </View>
          <Text style={[styles.retentionLabel, { marginTop: 14 }]}>Extended-retention window</Text>
          <Text style={styles.retentionSub}>Applied to sessions flagged Keep in the player.</Text>
          <View style={styles.chipRow}>
            {EXTENDED_RETENTION_OPTIONS.map((opt) => {
              const selected = extendedRetentionMonths === opt.value;
              return (<TouchableOpacity key={opt.value} testID={`rum-extended-retention-${opt.value}`} disabled={savingRetention} onPress={() => saveRetention('extendedRetentionMonths', opt.value)} style={[styles.chip, selected && styles.chipActive, savingRetention && styles.btnDisabled]}>
                  <Text style={[styles.chipText, selected && styles.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>);
            })}
          </View>
          {retentionError && <Text style={styles.error}>{retentionError}</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.gray950 },
    content: { padding: 16, paddingBottom: 32 },
    sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.white, marginTop: 16, marginBottom: 6 },
    hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    row: { fontSize: 13, color: colors.gray300, marginBottom: 4 },
    error: { fontSize: 13, color: colors.red400, marginTop: 6 },
    primaryBtn: {
        backgroundColor: colors.emerald800_50,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        marginTop: 8,
    },
    secondaryBtn: {
        marginTop: 8,
        paddingVertical: 10,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
    },
    primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
    secondaryBtnText: { color: colors.gray300 },
    btnDisabled: { opacity: 0.5 },
    createRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
    input: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        padding: 10,
        color: colors.white,
        fontSize: 14,
    },
    clientCard: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    clientName: { fontSize: 14, color: colors.white, fontWeight: '500' },
    clientMeta: { fontSize: 11, color: colors.gray500, marginTop: 2 },
    tokenBox: {
        backgroundColor: colors.yellow900_50,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: colors.amber900_40,
    },
    tokenLabel: { fontSize: 12, color: colors.amber400, marginBottom: 6 },
    tokenValue: { fontSize: 11, color: colors.gray200, fontFamily: 'monospace' },
    link: { fontSize: 12, color: colors.blue400, marginTop: 8 },
    retentionLabel: { fontSize: 13, color: colors.gray200, fontWeight: '600' },
    retentionSub: { fontSize: 11, color: colors.gray500, marginTop: 2 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray700,
        backgroundColor: colors.gray900,
    },
    chipActive: { backgroundColor: colors.emerald800_50, borderColor: colors.emerald400 },
    chipText: { color: colors.gray300, fontSize: 12, fontWeight: '500' },
    chipTextActive: { color: colors.emerald400 },
});
