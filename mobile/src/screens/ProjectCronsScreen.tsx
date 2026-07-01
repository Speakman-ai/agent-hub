import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Switch, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime, relativeFuture } from '../utils/time';
import humanCron from '@shared/utils/humanCron';
import { localTimeZone } from '@shared/utils/calendarEvents';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
const EMPTY_FORM: Record<string, any> = {
    name: '',
    schedule: '*/30 * * * *',
    timezone: localTimeZone(),
    prompt: '',
    enabled: true,
    shared: false,
};
export default function ProjectCronsScreen({ route, navigation }: any) {
    const { projectId, project: routeProject } = route.params || {};
    const project = routeProject;
    const [crons, setCrons] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [running, setRunning] = useState<any>({});
    const [editingId, setEditingId] = useState<any>(null);
    const [editForm, setEditForm] = useState<any>({});
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api.getCrons();
            setCrons((data || []).filter((c: any) => c.project_id === projectId));
        }
        catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to load crons');
            setCrons([]);
        }
        finally {
            setLoading(false);
        }
    }, [projectId]);
    useEffect(() => {
        load();
        const id = setInterval(load, 60000);
        return () => clearInterval(id);
    }, [load]);
    const createCron = async () => {
        if (!form.name || !form.schedule || !form.prompt) {
            Alert.alert('Missing fields', 'Name, schedule, and prompt are required.');
            return;
        }
        try {
            const created = await api.createCron({
                ...form,
                timezone: form.timezone || localTimeZone(),
                project_id: projectId,
                cwd: project?.cwd || '',
            });
            setCrons((prev: any) => [...prev, created]);
            setShowForm(false);
            setForm(EMPTY_FORM);
        }
        catch (err: any) {
            Alert.alert('Create failed', err?.message || 'Could not create cron');
        }
    };
    const saveEdit = async () => {
        if (!editForm.name || !editForm.schedule || !editForm.prompt) {
            Alert.alert('Missing fields', 'Name, schedule, and prompt are required.');
            return;
        }
        try {
            const updated = await api.updateCron(editingId, editForm);
            setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
            setEditingId(null);
            setEditForm({});
        }
        catch (err: any) {
            Alert.alert('Save failed', err?.message || 'Could not save cron');
        }
    };
    const toggleCron = async (cronJob: any) => {
        const updated = await api.updateCron(cronJob.id, { enabled: !cronJob.enabled });
        setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
    };
    const deleteCron = (id: any) => {
        Alert.alert('Delete Cron', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    await api.deleteCron(id);
                    setCrons((prev: any) => prev.filter((c: any) => c.id !== id));
                },
            },
        ]);
    };
    const triggerRun = async (id: any) => {
        setRunning((prev: any) => ({ ...prev, [id]: true }));
        try {
            await api.runCron(id);
        }
        catch (err: any) {
            Alert.alert('Run failed', err?.message || 'Could not run cron');
        }
        setTimeout(() => setRunning((prev: any) => ({ ...prev, [id]: false })), 3000);
    };
    const renderForm = (f: any, setF: any, onSubmit: any, submitLabel: any) => (<View style={styles.formCard}>
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={f.name} onChangeText={(v: any) => setF({ ...f, name: v })} placeholderTextColor={colors.gray600}/>
      <Text style={styles.label}>Schedule (cron)</Text>
      <TextInput style={styles.input} value={f.schedule} onChangeText={(v: any) => setF({ ...f, schedule: v })} placeholder="*/30 * * * *" placeholderTextColor={colors.gray600}/>
      <Text style={styles.label}>Prompt</Text>
      <TextInput style={[styles.input, { minHeight: 72 }]} value={f.prompt} onChangeText={(v: any) => setF({ ...f, prompt: v })} multiline placeholderTextColor={colors.gray600}/>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Enabled</Text>
        <Switch value={!!f.enabled} onValueChange={(v: any) => setF({ ...f, enabled: v })} trackColor={{ false: colors.gray700, true: colors.emerald800_50 }} thumbColor={f.enabled ? colors.emerald400 : colors.gray500}/>
      </View>
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Shared</Text>
          <Text style={styles.meta}>Visible to the org. Runs still use the owner credentials.</Text>
        </View>
        <Switch value={!!f.shared} onValueChange={(v: any) => setF({ ...f, shared: v })} trackColor={{ false: colors.gray700, true: colors.blue500 }} thumbColor={f.shared ? colors.blue400 : colors.gray500}/>
      </View>
      <TouchableOpacity style={styles.primaryBtn} onPress={onSubmit}>
        <Text style={styles.primaryBtnText}>{submitLabel}</Text>
      </TouchableOpacity>
    </View>);
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Cron Jobs" project={project} onBack={() => navigation.goBack()}/>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Text style={styles.desc}>Scheduled tasks scoped to this project.</Text>
          <TouchableOpacity onPress={() => setShowForm((v: any) => !v)}>
            <Text style={styles.link}>{showForm ? 'Cancel' : '+ New'}</Text>
          </TouchableOpacity>
        </View>

        {showForm && renderForm(form, setForm, createCron, 'Create')}

        {loading ? (<ActivityIndicator color={colors.gray400} style={{ marginTop: 24 }}/>) : crons.length === 0 ? (<Text style={styles.empty}>No cron jobs for this project.</Text>) : (crons.map((cronJob: any) => (<View key={cronJob.id} style={styles.card}>
              {editingId === cronJob.id ? (<>
                  {renderForm(editForm, setEditForm, saveEdit, 'Save')}
                  <TouchableOpacity onPress={() => { setEditingId(null); setEditForm({}); }}>
                    <Text style={styles.link}>Cancel edit</Text>
                  </TouchableOpacity>
                </>) : (<>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{cronJob.name}</Text>
                    <Switch value={!!cronJob.enabled} onValueChange={() => toggleCron(cronJob)} disabled={!cronJob.can_manage} trackColor={{ false: colors.gray700, true: colors.emerald800_50 }} thumbColor={cronJob.enabled ? colors.emerald400 : colors.gray500}/>
                  </View>
                  <Text style={styles.mono}>{humanCron(cronJob.schedule)}</Text>
                  {!!cronJob.timezone && <Text style={styles.meta}>{cronJob.timezone}</Text>}
                  <View style={styles.badgeRow}>
                    <Text style={styles.badge}>{cronJob.shared ? 'Shared' : 'Private'}</Text>
                    {!!cronJob.owner_username && (
                      <Text style={styles.badge}>Owner: {cronJob.owner_username}</Text>
                    )}
                  </View>
                  {cronJob.enabled && cronJob.next_run_at && (<Text style={styles.meta}>
                      Next: {relativeFuture(cronJob.next_run_at).label || '—'}
                    </Text>)}
                  <Text style={styles.prompt} numberOfLines={2}>{cronJob.prompt}</Text>
                  {cronJob.last_run && (<Text style={styles.meta}>Last: {relativeTime(cronJob.last_run)}</Text>)}
                  <View style={styles.actions}>
                    <TouchableOpacity style={[styles.actionBtn, (!cronJob.can_manage || running[cronJob.id]) && styles.disabledBtn]} onPress={() => triggerRun(cronJob.id)} disabled={!cronJob.can_manage || running[cronJob.id]}>
                      <Text style={styles.actionText}>{running[cronJob.id] ? 'Running…' : 'Run'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, !cronJob.can_manage && styles.disabledBtn]} disabled={!cronJob.can_manage} onPress={() => {
                    setEditingId(cronJob.id);
                    setEditForm({
                        name: cronJob.name,
                        schedule: cronJob.schedule,
                        timezone: cronJob.timezone || localTimeZone(),
                        prompt: cronJob.prompt,
                        enabled: cronJob.enabled,
                        shared: !!cronJob.shared,
                        project_id: projectId,
                        cwd: cronJob.cwd || project?.cwd || '',
                    });
                }}>
                      <Text style={styles.actionText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, !cronJob.can_manage && styles.disabledBtn]} disabled={!cronJob.can_manage} onPress={() => deleteCron(cronJob.id)}>
                      <Text style={[styles.actionText, { color: colors.red400 }]}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </>)}
            </View>)))}
      </ScrollView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.gray950 },
    content: { padding: 16, paddingBottom: 32 },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    desc: { fontSize: 13, color: colors.gray500, flex: 1 },
    link: { fontSize: 13, color: colors.blue400 },
    empty: { fontSize: 14, color: colors.gray500, marginTop: 16 },
    formCard: {
        backgroundColor: colors.gray900,
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    label: { fontSize: 12, color: colors.gray400, marginBottom: 4, marginTop: 8 },
    input: {
        backgroundColor: colors.gray950,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        padding: 10,
        color: colors.white,
        fontSize: 14,
    },
    switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
    primaryBtn: {
        marginTop: 12,
        backgroundColor: colors.emerald800_50,
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
    },
    primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 10,
        padding: 12,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    cardTitle: { fontSize: 15, fontWeight: '600', color: colors.white, flex: 1 },
    mono: { fontSize: 12, color: colors.gray400, fontFamily: 'monospace', marginTop: 4 },
    badgeRow: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
    badge: {
        fontSize: 10,
        color: colors.gray300,
        backgroundColor: colors.gray800,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    prompt: { fontSize: 13, color: colors.gray300, marginTop: 6 },
    meta: { fontSize: 11, color: colors.gray500, marginTop: 4 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    actionBtn: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: colors.gray800,
    },
    disabledBtn: { opacity: 0.4 },
    actionText: { fontSize: 12, color: colors.gray300 },
});
