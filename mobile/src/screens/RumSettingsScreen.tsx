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
});
