import React, { useState, useEffect, useMemo, useContext } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Pressable, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import HubIcon from '../components/HubIcon';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime, relativeFuture } from '../utils/time';
import { normalizeSettingsTab } from '../utils/settingsTabs';
import humanCron from '@shared/utils/humanCron';
import { cronEngineChoices, defaultModelForCronEngine, effectiveCronEngine, inheritedCronEngineForHelper, modelsForCronEngine, } from '../utils/cronEngine';
import { getOrgs, getActiveOrg, createOrg, updateOrg, deleteOrg, testConnection, loadOrgs } from '../utils/orgs';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import SlackBotsSection from '../components/settings/SlackBotsSection';
import MyCliKeysSection from '../components/settings/MyCliKeysSection';
import PushNotificationsSection from '../components/settings/PushNotificationsSection';
import GeneralSettingsSection from '../components/settings/GeneralSettingsSection';
import GitHubSettingsSection from '../components/settings/GitHubSettingsSection';
import ToolErrorsSection from '../components/settings/ToolErrorsSection';
import ServerLogsSection from '../components/settings/ServerLogsSection';
import MembersSection from '../components/settings/MembersSection';
import MfaSettingsSection from '../components/settings/MfaSettingsSection';
import SmtpSettingsSection from '../components/settings/SmtpSettingsSection';
import GoogleConnectionSection from '../components/settings/GoogleConnectionSection';
// ─── Organizations (Server Connections) Tab ──────────────────
function OrganizationsSection() {
    const { handleSwitchOrg } = useApp();
    const [orgsState, setOrgsState] = useState(() => getOrgs());
    const [expandedOrgId, setExpandedOrgId] = useState<any>(null);
    const [editForm, setEditForm] = useState<any>({});
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<any>(null);
    const [showNewForm, setShowNewForm] = useState(false);
    const [newForm, setNewForm] = useState<any>({ name: '', color: '#6366f1', remoteUrl: '', apiKey: '' });
    const [showApiKey, setShowApiKey] = useState(false);
    const orgs = orgsState?.orgs || [];
    const activeOrg = getActiveOrg();
    const COLORS = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
    const refreshOrgs = async () => {
        await loadOrgs();
        setOrgsState(getOrgs());
    };
    const handleExpand = (orgId: any) => {
        if (expandedOrgId === orgId) {
            setExpandedOrgId(null);
            return;
        }
        const org = orgs.find((o: any) => o.id === orgId);
        if (org) {
            setEditForm({ name: org.name, color: org.color, remoteUrl: org.remoteUrl || '', apiKey: org.apiKey || '' });
            setExpandedOrgId(orgId);
            setTestResult(null);
        }
    };
    const handleTest = async (url: any, apiKey: any) => {
        setTesting(true);
        setTestResult(null);
        const result = await testConnection(url, apiKey);
        setTestResult(result);
        setTesting(false);
    };
    const handleSave = async () => {
        if (!editForm.name?.trim())
            return;
        await updateOrg(expandedOrgId, editForm);
        await refreshOrgs();
        if (activeOrg?.id === expandedOrgId) {
            await handleSwitchOrg(expandedOrgId);
        }
        setExpandedOrgId(null);
    };
    const handleDelete = async (orgId: any) => {
        if (orgs.length <= 1) {
            Alert.alert('Cannot Delete', 'You must have at least one server connection.');
            return;
        }
        Alert.alert('Delete Server', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive',
                onPress: async () => {
                    const wasActive = activeOrg?.id === orgId;
                    await deleteOrg(orgId);
                    await refreshOrgs();
                    if (wasActive) {
                        const newOrgs = getOrgs();
                        if (newOrgs?.orgs?.[0])
                            await handleSwitchOrg(newOrgs.orgs[0].id);
                    }
                    setExpandedOrgId(null);
                },
            },
        ]);
    };
    const handleCreate = async () => {
        if (!newForm.name?.trim() || !newForm.remoteUrl?.trim()) {
            Alert.alert('Missing Fields', 'Name and Server URL are required.');
            return;
        }
        await createOrg(newForm);
        await refreshOrgs();
        setNewForm({ name: '', color: '#6366f1', remoteUrl: '', apiKey: '' });
        setShowNewForm(false);
    };
    const handleSwitch = async (orgId: any) => {
        await handleSwitchOrg(orgId);
        await refreshOrgs();
    };
    const renderColorPicker = (selectedColor: any, onSelect: any) => (<View style={styles.colorRow}>
      {COLORS.map((c: any) => (<TouchableOpacity key={c} style={[styles.colorBtn, { backgroundColor: c }, selectedColor === c && styles.colorBtnSelected]} onPress={() => onSelect(c)}/>))}
    </View>);
    const renderForm = (form: any, setForm: any, onTest: any) => (<View style={styles.orgForm}>
      <Text style={styles.inputLabel}>Name</Text>
      <TextInput style={styles.textInput} value={form.name} onChangeText={(v: any) => setForm((f: any) => ({ ...f, name: v }))} placeholder="e.g. Production, Home Lab" placeholderTextColor={colors.gray600}/>
      <Text style={[styles.inputLabel, { marginTop: 12 }]}>Color</Text>
      {renderColorPicker(form.color, (c: any) => setForm((f: any) => ({ ...f, color: c })))}
      <Text style={[styles.inputLabel, { marginTop: 12 }]}>Server URL</Text>
      <TextInput style={styles.textInput} value={form.remoteUrl} onChangeText={(v: any) => setForm((f: any) => ({ ...f, remoteUrl: v }))} placeholder="https://my-server.example.com:3051" placeholderTextColor={colors.gray600} autoCapitalize="none" autoCorrect={false} keyboardType="url"/>
      <Text style={[styles.inputLabel, { marginTop: 12 }]}>API Key (optional)</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput style={[styles.textInput, { flex: 1 }]} value={form.apiKey} onChangeText={(v: any) => setForm((f: any) => ({ ...f, apiKey: v }))} placeholder="Enter API key if required" placeholderTextColor={colors.gray600} secureTextEntry={!showApiKey} autoCapitalize="none" autoCorrect={false}/>
        <TouchableOpacity onPress={() => setShowApiKey((v: any) => !v)} style={{ paddingHorizontal: 8, paddingVertical: 10 }}>
          <Text style={{ color: colors.gray400, fontSize: 13 }}>{showApiKey ? 'Hide' : 'Show'}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.testBtn} onPress={() => onTest(form.remoteUrl, form.apiKey)} disabled={testing || !form.remoteUrl}>
        <Text style={styles.testBtnText}>{testing ? 'Testing...' : 'Test Connection'}</Text>
      </TouchableOpacity>
      {testResult && (<Text style={[styles.testResultText, { color: testResult.ok ? colors.emerald400 : colors.red400 }]}>
          {testResult.ok ? '✓ ' : '✕ '}{testResult.message}
        </Text>)}
    </View>);
    return (<View>
      <Text style={styles.sectionTitle}>Server Connections</Text>
      <Text style={styles.sectionDesc}>Manage your remote Agent Hub server connections.</Text>

      {orgs.map((org: any) => {
            const isActive = org.id === activeOrg?.id;
            const isExpanded = expandedOrgId === org.id;
            return (<View key={org.id} style={styles.orgCard}>
            <TouchableOpacity style={styles.orgCardHeader} onPress={() => handleExpand(org.id)}>
              <View style={[styles.orgCardDot, { backgroundColor: org.color }]}/>
              <View style={{ flex: 1 }}>
                <Text style={styles.orgCardName}>{org.name}</Text>
                {org.remoteUrl ? (<Text style={styles.orgCardUrl} numberOfLines={1}>{org.remoteUrl}</Text>) : (<Text style={[styles.orgCardUrl, { color: colors.yellow400 }]}>No URL configured</Text>)}
              </View>
              {isActive && (<View style={styles.activeBadge}>
                  <Text style={styles.activeBadgeText}>Active</Text>
                </View>)}
              {!isActive && (<TouchableOpacity style={styles.switchBtn} onPress={() => handleSwitch(org.id)}>
                  <Text style={styles.switchBtnText}>Switch</Text>
                </TouchableOpacity>)}
              <Text style={styles.expandChevron}>{isExpanded ? '▴' : '▾'}</Text>
            </TouchableOpacity>

            {isExpanded && (<View style={styles.orgCardExpanded}>
                {renderForm(editForm, setEditForm, handleTest)}
                <View style={styles.orgCardActions}>
                  <TouchableOpacity style={[styles.deleteBtn, orgs.length <= 1 && { opacity: 0.3 }]} onPress={() => handleDelete(org.id)} disabled={orgs.length <= 1}>
                    <Text style={styles.deleteBtnText}>Delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                    <Text style={styles.saveBtnText}>Save Changes</Text>
                  </TouchableOpacity>
                </View>
              </View>)}
          </View>);
        })}

      {/* Add new org */}
      {showNewForm ? (<View style={styles.newOrgCard}>
          {renderForm(newForm, setNewForm, handleTest)}
          <View style={styles.orgCardActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNewForm(false)}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.saveBtn, (!newForm.name?.trim() || !newForm.remoteUrl?.trim()) && { opacity: 0.4 }]} onPress={handleCreate} disabled={!newForm.name?.trim() || !newForm.remoteUrl?.trim()}>
              <Text style={styles.saveBtnText}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>) : (<TouchableOpacity style={styles.addOrgBtn} onPress={() => setShowNewForm(true)}>
          <Text style={styles.addOrgBtnText}>+ Add Server</Text>
        </TouchableOpacity>)}
    </View>);
}
const PLUGIN_API_KEYS = [
    {
        id: 'xai',
        label: 'xAI API key',
        placeholder: 'xai-...',
        description: 'Used for voice transcription (the default provider).',
        load: () => api.getConfig(),
        loadConfigured: (body: any) => !!body.xaiApiKeySet || !!body.xaiApiKey,
        save: (value: any) => api.updateConfig({ xaiApiKey: value }),
        clear: () => api.updateConfig({ xaiApiKey: '' }),
        savedConfigured: (body: any) => !!body?.updated?.xaiApiKey,
    },
    {
        id: 'gemini',
        label: 'Gemini API key',
        placeholder: 'AIza...',
        description: 'Used for voice transcription and wiki RAG.',
        load: () => api.getGeminiAuth(),
        loadConfigured: (body: any) => !!body?.apiKey?.configured,
        save: (value: any) => api.setGeminiApiKey(value),
        clear: () => api.logoutGemini(),
        savedConfigured: (body: any) => !!body?.configured,
    },
    {
        id: 'openai',
        label: 'OpenAI API key',
        placeholder: 'sk-...',
        description: 'Plugin use: voice transcription only. Also used for generated session titles.',
        load: () => api.getConfig(),
        loadConfigured: (body: any) => !!body.openaiApiKeySet || !!body.openaiApiKey,
        save: (value: any) => api.updateConfig({ openaiApiKey: value }),
        clear: () => api.updateConfig({ openaiApiKey: '' }),
        savedConfigured: (body: any) => !!body?.updated?.openaiApiKey,
    },
];
function PluginApiKeyField({ item }: any) {
    const [loading, setLoading] = useState(true);
    const [configured, setConfigured] = useState(false);
    const [apiKey, setApiKey] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<any>(null);
    const load = async () => {
        setLoading(true);
        setStatus(null);
        try {
            const body = await item.load();
            setConfigured(item.loadConfigured(body));
        }
        catch (err: any) {
            setStatus({ type: 'error', message: err.message || String(err) });
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        load();
    }, []);
    const saveKey = async (value: any) => {
        setSaving(true);
        setStatus(null);
        try {
            const trimmed = value.trim();
            const body = trimmed ? await item.save(trimmed) : await item.clear();
            const nextConfigured = item.savedConfigured(body);
            setConfigured(nextConfigured);
            setApiKey('');
            setStatus({ type: 'success', message: nextConfigured ? 'Saved' : 'Cleared' });
        }
        catch (err: any) {
            setStatus({ type: 'error', message: err.message || String(err) });
        }
        finally {
            setSaving(false);
        }
    };
    return (<View style={styles.pluginKeyCard}>
      <View style={styles.pluginKeyHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.pluginKeyTitle}>{item.label}</Text>
          <Text style={styles.sectionDesc}>{item.description}</Text>
        </View>
        {!loading && (<Text style={[styles.accountStatusText, { color: configured ? colors.emerald400 : colors.gray500 }]}>
            {configured ? 'Configured' : 'Not configured'}
          </Text>)}
      </View>

      {loading ? (<ActivityIndicator color={colors.indigo500} style={{ marginTop: 12 }}/>) : (<>
          <Text style={[styles.inputLabel, { marginTop: 12 }]}>{item.label}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput style={[styles.textInput, { flex: 1 }]} value={apiKey} onChangeText={(value: any) => {
                setApiKey(value);
                setStatus(null);
            }} placeholder={item.placeholder} placeholderTextColor={colors.gray600} secureTextEntry={!showApiKey} autoCapitalize="none" autoCorrect={false}/>
            <TouchableOpacity onPress={() => setShowApiKey((value: any) => !value)} style={{ paddingHorizontal: 8, paddingVertical: 10 }}>
              <Text style={{ color: colors.gray400, fontSize: 13 }}>
                {showApiKey ? 'Hide' : 'Show'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.accountActionRow}>
            <TouchableOpacity style={[styles.saveBtn, (!apiKey.trim() || saving) && { opacity: 0.4 }]} onPress={() => saveKey(apiKey)} disabled={!apiKey.trim() || saving}>
              <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save API Key'}</Text>
            </TouchableOpacity>
            {configured && (<TouchableOpacity style={[styles.accountDangerBtn, saving && { opacity: 0.4 }]} onPress={() => saveKey('')} disabled={saving}>
                <Text style={styles.accountDangerBtnText}>Clear</Text>
              </TouchableOpacity>)}
          </View>
        </>)}

      {status && (<Text style={[
                styles.accountStatusNote,
                { color: status.type === 'success' ? colors.emerald400 : colors.red400 },
            ]}>
          {status.message}
        </Text>)}
    </View>);
}
function GlobalApiKeysSection() {
    return (<View>
      <Text style={styles.sectionTitle}>Global API Keys</Text>
      <Text style={styles.sectionDesc}>
        Host-wide keys used by Agent Hub services (wiki embeddings, transcription, etc.).
      </Text>

      <View style={styles.accountCard}>
        <SmtpSettingsSection />
        {PLUGIN_API_KEYS.map((item: any) => (<PluginApiKeyField key={item.id} item={item}/>))}
      </View>
    </View>);
}
function AccountSection() {
    return (<View>
      <Text style={styles.sectionTitle}>Account</Text>
      <Text style={styles.sectionDesc}>
        Your personal CLI credentials and engine overrides for agents you run.
      </Text>
      <GoogleConnectionSection />
      <MfaSettingsSection />
      <MyCliKeysSection />
      <MembersSection />
    </View>);
}
// ─── Usage Analytics Tab ─────────────────────────────────────
function UsageSection() {
    const [usage, setUsage] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        api.getUsage()
            .then(setUsage)
            .catch(() => setUsage(null))
            .finally(() => setLoading(false));
    }, []);
    const fmtCost = (c: any) => `$${Number(c || 0).toFixed(2)}`;
    const fmtDuration = (ms: any) => {
        if (!ms)
            return '0s';
        const s = ms / 1000;
        if (s < 60)
            return `${Math.round(s)}s`;
        if (s < 3600)
            return `${(s / 60).toFixed(1)}m`;
        return `${(s / 3600).toFixed(1)}h`;
    };
    if (loading)
        return <Text style={styles.emptyText}>Loading usage data...</Text>;
    if (!usage || !usage.totals)
        return <Text style={styles.emptyText}>No usage data available yet.</Text>;
    const maxDailyCost = Math.max(...(usage.byDay || []).map((d: any) => d.cost || 0), 0.01);
    return (<View>
      <Text style={styles.sectionTitle}>Usage Analytics</Text>

      {/* Summary cards */}
      <View style={styles.usageGrid}>
        <View style={styles.usageCard}>
          <Text style={[styles.usageValue, { color: colors.emerald400 }]}>{fmtCost(usage.totals.total_cost)}</Text>
          <Text style={styles.usageLabel}>Total Cost</Text>
        </View>
        <View style={styles.usageCard}>
          <Text style={[styles.usageValue, { color: colors.blue400 }]}>{fmtDuration(usage.totals.total_duration_ms)}</Text>
          <Text style={styles.usageLabel}>Total Time</Text>
        </View>
        <View style={styles.usageCard}>
          <Text style={styles.usageValue}>{usage.totals.total_turns || 0}</Text>
          <Text style={styles.usageLabel}>Turns</Text>
        </View>
        <View style={styles.usageCard}>
          <Text style={styles.usageValue}>{usage.totals.count || 0}</Text>
          <Text style={styles.usageLabel}>Messages</Text>
        </View>
      </View>

      {/* By Agent */}
      {usage.byAgent?.length > 0 && (<View style={{ marginTop: 20 }}>
          <Text style={styles.subsectionTitle}>By Agent</Text>
          {usage.byAgent.map((a: any) => (<View key={a.agent_id} style={styles.agentUsageRow}>
              <View style={[styles.agentUsageDot, { backgroundColor: a.agent_color || colors.gray500 }]}/>
              <Text style={styles.agentUsageName} numberOfLines={1}>{a.agent_name}</Text>
              <Text style={[styles.agentUsageStat, { color: colors.emerald400 }]}>{fmtCost(a.total_cost)}</Text>
              <Text style={styles.agentUsageStat}>{fmtDuration(a.total_duration_ms)}</Text>
              <Text style={styles.agentUsageStat}>{a.count || 0}</Text>
            </View>))}
        </View>)}

      {/* Daily Cost Chart */}
      {usage.byDay?.length > 0 && (<View style={{ marginTop: 20 }}>
          <Text style={styles.subsectionTitle}>Daily Cost (30 days)</Text>
          {usage.byDay.map((d: any) => (<View key={d.day} style={styles.dailyRow}>
              <Text style={styles.dailyDate}>{d.day.slice(5)}</Text>
              <View style={styles.dailyBarContainer}>
                <View style={[styles.dailyBar, { flex: Math.max((d.cost || 0) / maxDailyCost, 0.01) }]}/>
              </View>
              <Text style={styles.dailyCost}>{fmtCost(d.cost)}</Text>
            </View>))}
        </View>)}

      {/* Recent Sessions */}
      {usage.recentSessions?.length > 0 && (<View style={{ marginTop: 20 }}>
          <Text style={styles.subsectionTitle}>Recent Sessions</Text>
          {usage.recentSessions.slice(0, 10).map((s: any) => (<View key={s.id} style={styles.recentSessionRow}>
              <View style={[styles.agentUsageDot, { backgroundColor: s.agent_color || colors.gray500 }]}/>
              <View style={{ flex: 1 }}>
                <Text style={styles.recentSessionName} numberOfLines={1}>{s.session_name}</Text>
                <Text style={styles.recentSessionAgent}>{s.agent_name} · {s.message_count} msgs</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.agentUsageStat, { color: colors.emerald400 }]}>{fmtCost(s.cost)}</Text>
                <Text style={styles.recentSessionAgent}>{fmtDuration(s.duration_ms)}</Text>
              </View>
            </View>))}
        </View>)}
    </View>);
}
// ─── Config Backup Tab ───────────────────────────────────────
function ConfigBackupSection() {
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<any>(null);
    const [importError, setImportError] = useState<any>(null);
    const [preview, setPreview] = useState<any>(null);
    const handleExport = async () => {
        setExporting(true);
        try {
            const data = await api.exportConfig();
            const json = JSON.stringify(data, null, 2);
            const now = new Date();
            const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const filename = `agent-hub-export-${localDate}.json`;
            const filePath = `${(FileSystem as any).cacheDirectory}${filename}`;
            await FileSystem.writeAsStringAsync(filePath, json);
            await Sharing.shareAsync(filePath, { mimeType: 'application/json', dialogTitle: 'Export Agent Hub Config' });
        }
        catch (err: any) {
            Alert.alert('Export Failed', err.message);
        }
        setExporting(false);
    };
    const handlePickFile = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
            if (result.canceled)
                return;
            const file = result.assets?.[0];
            if (!file)
                return;
            const content = await FileSystem.readAsStringAsync(file.uri);
            const data = JSON.parse(content);
            if (!data.version || ![1, 2].includes(data.version)) {
                setImportError('Invalid export file — missing or unsupported version.');
                return;
            }
            setPreview(data);
            setImportError(null);
            setImportResult(null);
        }
        catch (err: any) {
            setImportError('Failed to read file: ' + err.message);
        }
    };
    const handleImport = async () => {
        if (!preview)
            return;
        setImporting(true);
        setImportError(null);
        try {
            const result = await api.importConfig(preview);
            setImportResult(result);
            setPreview(null);
        }
        catch (err: any) {
            setImportError('Import failed: ' + err.message);
        }
        setImporting(false);
    };
    return (<View>
      <Text style={styles.sectionTitle}>Config Backup</Text>

      {/* Export */}
      <View style={styles.backupCard}>
        <Text style={styles.backupCardTitle}>Export</Text>
        <Text style={styles.backupCardDesc}>
          Download all agents, crons, rooms, and configuration as a JSON file.
        </Text>
        <TouchableOpacity style={styles.saveBtn} onPress={handleExport} disabled={exporting}>
          <Text style={styles.saveBtnText}>{exporting ? 'Exporting...' : 'Share Export File'}</Text>
        </TouchableOpacity>
      </View>

      {/* Import */}
      <View style={[styles.backupCard, { marginTop: 16 }]}>
        <Text style={styles.backupCardTitle}>Import</Text>
        <Text style={styles.backupCardDesc}>
          Restore configuration from a previously exported JSON file.
        </Text>

        {!preview ? (<TouchableOpacity style={styles.testBtn} onPress={handlePickFile}>
            <Text style={styles.testBtnText}>Choose File</Text>
          </TouchableOpacity>) : (<View>
            <View style={styles.previewCard}>
              <Text style={styles.previewTitle}>Import Preview</Text>
              {preview.agents && <Text style={styles.previewLine}>Agents: {Array.isArray(preview.agents) ? preview.agents.length : 0}</Text>}
              {preview.crons && <Text style={styles.previewLine}>Crons: {Array.isArray(preview.crons) ? preview.crons.length : 0}</Text>}
              {preview.rooms && <Text style={styles.previewLine}>Rooms: {Array.isArray(preview.rooms) ? preview.rooms.length : 0}</Text>}
              {preview.projects && <Text style={styles.previewLine}>Projects: {Array.isArray(preview.projects) ? preview.projects.length : 0}</Text>}
              {preview.exportedAt && <Text style={styles.previewLine}>Exported: {new Date(preview.exportedAt).toLocaleString()}</Text>}
            </View>
            <View style={styles.orgCardActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setPreview(null)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleImport} disabled={importing}>
                <Text style={styles.saveBtnText}>{importing ? 'Importing...' : 'Import'}</Text>
              </TouchableOpacity>
            </View>
          </View>)}

        {importResult && (<View style={styles.successBox}>
            <Text style={styles.successText}>✓ {importResult.message || 'Import complete'}</Text>
          </View>)}

        {importError && (<View style={styles.errorBox}>
            <Text style={styles.errorBoxText}>✕ {importError}</Text>
          </View>)}
      </View>
    </View>);
}
// ─── Heartbeats Tab ─────────────────────────────────────────
function HeartbeatSection() {
    const [heartbeats, setHeartbeats] = useState<any[]>([]);
    const [expandedAgent, setExpandedAgent] = useState<any>(null);
    const [logs, setLogs] = useState<any>({});
    const [running, setRunning] = useState<any>({});
    const [editingId, setEditingId] = useState<any>(null);
    const [editForm, setEditForm] = useState({
        interval: '',
        prompt: '',
        model: '',
        shared: false,
    });
    // Heartbeat always spawns the Claude CLI, so the picker is locked to the
    // claude-code engine catalog from /api/config/models.
    const [claudeModels, setClaudeModels] = useState<any[]>([]);
    // Tick every 30s so the "next run in Xm" badges decrement live without
    // hitting the network. Server is re-polled every 60s for fresh state.
    const [, setTick] = useState(0);
    useEffect(() => {
        const refresh = () => api.getHeartbeats().then(setHeartbeats).catch(console.error);
        refresh();
        api
            .getModelConfig()
            .then((cfg: any) => setClaudeModels(cfg?.engineValidModels?.['claude-code'] || []))
            .catch(() => { });
        const pollId = setInterval(refresh, 60000);
        const tickId = setInterval(() => setTick((t: any) => t + 1), 30000);
        return () => {
            clearInterval(pollId);
            clearInterval(tickId);
        };
    }, []);
    const loadLogs = async (agentId: any) => {
        if (expandedAgent === agentId) {
            setExpandedAgent(null);
            return;
        }
        setExpandedAgent(agentId);
        const data = await api.getHeartbeatLogs(agentId, 20);
        setLogs((prev: any) => ({ ...prev, [agentId]: data }));
    };
    const toggleHeartbeat = async (agentId: any, current: any) => {
        try {
            const updated = await api.updateHeartbeat(agentId, { enabled: !current });
            setHeartbeats((prev: any) => prev.map((h: any) => h.agentId === agentId
                ? { ...h, ...updated }
                : h));
        }
        catch (e: any) {
            Alert.alert('Update failed', e?.message || 'Could not update heartbeat.');
        }
    };
    const triggerRun = async (agentId: any) => {
        setRunning((prev: any) => ({ ...prev, [agentId]: true }));
        try {
            await api.runHeartbeat(agentId);
        }
        catch (e: any) {
            console.error(e);
        }
        setTimeout(() => setRunning((prev: any) => ({ ...prev, [agentId]: false })), 3000);
    };
    const startEdit = (hb: any) => {
        setEditingId(hb.agentId);
        setEditForm({
            interval: hb.heartbeat.interval || '',
            prompt: hb.heartbeat.prompt || '',
            model: hb.heartbeat.model || '',
            shared: !!hb.shared,
        });
    };
    const saveEdit = async () => {
        if (!editForm.interval || !editForm.prompt) {
            Alert.alert('Missing fields', 'Schedule and prompt are required.');
            return;
        }
        try {
            const updated = await api.updateHeartbeat(editingId, {
                interval: editForm.interval,
                prompt: editForm.prompt,
                // Send empty string explicitly so the server PUT route can clear an
                // existing override (it maps "" → undefined).
                model: editForm.model || '',
                shared: !!editForm.shared,
            });
            setHeartbeats((prev: any) => prev.map((h: any) => h.agentId === editingId
                ? { ...h, ...updated }
                : h));
            setEditingId(null);
        }
        catch (e: any) {
            Alert.alert('Save failed', e?.message || 'Could not save heartbeat.');
        }
    };
    const renderNextRunBadge = (hb: any) => {
        if (!hb.heartbeat.enabled || !hb.state?.next_run_at)
            return null;
        const { label, overdue } = relativeFuture(hb.state.next_run_at);
        if (!label)
            return null;
        return (<View style={[styles.nextRunBadge, overdue && styles.nextRunBadgeOverdue]}>
        <Text style={[styles.nextRunBadgeText, overdue && styles.nextRunBadgeTextOverdue]}>
          {label}
        </Text>
      </View>);
    };
    return (<View>
      <Text style={styles.sectionTitle}>Agent Heartbeats</Text>
      <View style={styles.cardList}>
        {heartbeats.map((hb: any) => (<View key={hb.agentId} style={styles.card}>
            {editingId === hb.agentId ? (<View style={styles.editForm}>
                <View style={styles.row}>
                  <View style={[styles.dot, { backgroundColor: hb.color }]}/>
                  <Text style={styles.cardName}>{hb.agentName}</Text>
                </View>
                <Text style={styles.fieldLabel}>Cron schedule</Text>
                <TextInput value={editForm.interval} onChangeText={(v: any) => setEditForm({ ...editForm, interval: v })} placeholder="e.g. 0 */12 * * *" placeholderTextColor={colors.gray500} style={styles.formInput} autoCapitalize="none" autoCorrect={false}/>
                {editForm.interval &&
                    humanCron(editForm.interval) !== editForm.interval && (<Text style={styles.cronPreview}>↳ {humanCron(editForm.interval)}</Text>)}
                <Text style={styles.fieldLabel}>Heartbeat prompt</Text>
                <TextInput value={editForm.prompt} onChangeText={(v: any) => setEditForm({ ...editForm, prompt: v })} placeholder="Heartbeat prompt" placeholderTextColor={colors.gray500} style={[styles.formInput, { minHeight: 80 }]} multiline textAlignVertical="top"/>
                {claudeModels.length > 0 && (<>
                    <Text style={styles.fieldLabel}>Model</Text>
                    <View style={styles.engineToggle}>
                      <TouchableOpacity style={[
                        styles.engineOption,
                        !editForm.model && styles.engineOptionActive,
                    ]} onPress={() => setEditForm({ ...editForm, model: '' })}>
                        <Text style={[
                        styles.engineOptionText,
                        !editForm.model && styles.engineOptionTextActive,
                    ]}>
                          default
                        </Text>
                      </TouchableOpacity>
                      {claudeModels.map((m: any) => (<TouchableOpacity key={m} style={[
                            styles.engineOption,
                            editForm.model === m && styles.engineOptionActive,
                        ]} onPress={() => setEditForm({ ...editForm, model: m })}>
                          <Text style={[
                            styles.engineOptionText,
                            editForm.model === m && styles.engineOptionTextActive,
                        ]}>
                            {m.replace(/^claude-/, '')}
                          </Text>
                        </TouchableOpacity>))}
                    </View>
                  </>)}
                <TouchableOpacity onPress={() => setEditForm({ ...editForm, shared: !editForm.shared })} style={styles.notifyToggleRow} accessibilityRole="checkbox" accessibilityState={{ checked: !!editForm.shared }}>
                  <View style={[
                    styles.notifyCheckbox,
                    !!editForm.shared && styles.notifyCheckboxChecked,
                ]}>
                    {!!editForm.shared && <Text style={styles.notifyCheckboxMark}>✓</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.notifyToggleLabel}>Shared</Text>
                    <Text style={styles.notifyToggleHint}>
                      Visible to the org. Runs still use the owner credentials.
                    </Text>
                  </View>
                </TouchableOpacity>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity style={styles.primaryBtn} onPress={saveEdit}>
                    <Text style={styles.primaryBtnText}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => setEditingId(null)}>
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>) : (<View style={styles.cardRow}>
              <View style={[styles.dot, { backgroundColor: hb.color }]}/>
              <View style={styles.cardInfo}>
                <View style={styles.row}>
                  <Text style={styles.cardName}>{hb.agentName}</Text>
                  <Text style={styles.mono}>{hb.heartbeat.interval ? humanCron(hb.heartbeat.interval) : 'not set'}</Text>
                  <Text style={styles.ownerBadge}>{hb.shared ? 'Shared' : 'Private'}</Text>
                  {!!hb.owner_username && (
                    <Text style={styles.ownerBadge}>Owner: {hb.owner_username}</Text>
                  )}
                  {renderNextRunBadge(hb)}
                </View>
                <Text style={styles.cardSubtext} numberOfLines={1}>
                  {hb.heartbeat.prompt || 'No prompt configured'}
                </Text>
                {hb.heartbeat.model ? (<Text style={styles.cardMeta}>model: {hb.heartbeat.model}</Text>) : null}
                <TouchableOpacity onPress={async () => {
                    try {
                        const updated = await api.updateHeartbeat(hb.agentId, { shared: !hb.shared });
                        setHeartbeats((prev: any) => prev.map((h: any) => h.agentId === hb.agentId ? { ...h, ...updated } : h));
                    }
                    catch (e: any) {
                        Alert.alert('Update failed', e?.message || 'Could not update heartbeat sharing.');
                    }
                }} disabled={!hb.can_manage} style={styles.inlineToggleRow} accessibilityRole="checkbox" accessibilityState={{ checked: !!hb.shared, disabled: !hb.can_manage }}>
                  <View style={[
                    styles.notifyCheckbox,
                    !!hb.shared && styles.notifyCheckboxChecked,
                    !hb.can_manage && styles.disabledControl,
                ]}>
                    {!!hb.shared && <Text style={styles.notifyCheckboxMark}>✓</Text>}
                  </View>
                  <Text style={[styles.notifyToggleLabel, !hb.can_manage && styles.disabledText]}>Shared</Text>
                </TouchableOpacity>
                {hb.latestLog && (<Text style={styles.cardMeta}>
                    Last run: {relativeTime(hb.latestLog.timestamp)} —{' '}
                    <Text style={hb.latestLog.status === 'success'
                        ? styles.statusSuccess
                        : hb.latestLog.status === 'error'
                            ? styles.statusError
                            : styles.statusPending}>
                      {hb.latestLog.status}
                    </Text>
                  </Text>)}
              </View>
              <View style={styles.actionButtons}>
                <TouchableOpacity style={[styles.smallButton, !hb.can_manage && styles.disabledControl]} onPress={() => startEdit(hb)} accessibilityLabel="Edit heartbeat" disabled={!hb.can_manage}>
                  <Text style={styles.smallButtonText}>✎</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.smallButton, !hb.can_manage && styles.disabledControl]} onPress={() => triggerRun(hb.agentId)} disabled={running[hb.agentId] || !hb.can_manage}>
                  <Text style={styles.smallButtonText}>
                    {running[hb.agentId] ? '...' : 'Run'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={[
                    styles.smallButton,
                    hb.heartbeat.enabled ? styles.buttonOn : styles.buttonOff,
                    !hb.can_manage && styles.disabledControl,
                ]} onPress={() => toggleHeartbeat(hb.agentId, hb.heartbeat.enabled)} disabled={!hb.can_manage}>
                  <Text style={[
                    styles.smallButtonText,
                    hb.heartbeat.enabled ? styles.buttonOnText : styles.buttonOffText,
                ]}>
                    {hb.heartbeat.enabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.smallButton} onPress={() => loadLogs(hb.agentId)}>
                  <Text style={styles.smallButtonText}>
                    {expandedAgent === hb.agentId ? '▲' : '▼'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>)}
            {expandedAgent === hb.agentId && (<View style={styles.logsContainer}>
                {(logs[hb.agentId] || []).length === 0 ? (<Text style={styles.emptyLogsText}>No logs yet</Text>) : ((logs[hb.agentId] || []).map((log: any) => (<View key={log.id} style={styles.logItem}>
                      <View style={styles.logHeader}>
                        <View style={[
                        styles.logStatusBadge,
                        log.status === 'success'
                            ? styles.logStatusSuccess
                            : log.status === 'error'
                                ? styles.logStatusError
                                : styles.logStatusPending,
                    ]}>
                          <Text style={[
                        styles.logStatusText,
                        log.status === 'success'
                            ? styles.statusSuccess
                            : log.status === 'error'
                                ? styles.statusError
                                : styles.statusPending,
                    ]}>
                            {log.status}
                          </Text>
                        </View>
                        <Text style={styles.logTime}>{relativeTime(log.timestamp)}</Text>
                      </View>
                      <Text style={styles.logResult} numberOfLines={5}>
                        {log.result || '(running...)'}
                      </Text>
                    </View>)))}
              </View>)}
          </View>))}
      </View>
    </View>);
}
// ─── Cron Jobs Tab ──────────────────────────────────────────
// Convert the form's minutes field into the API's `timeout_ms` contract:
//   - blank → null (use server default)
//   - positive integer → minutes * 60_000
// Returns `undefined` when the field is invalid so callers can surface an
// error instead of silently wiping the existing override.
function minutesToTimeoutMs(minutes: any) {
    if (minutes === '' || minutes === null || minutes === undefined)
        return null;
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0)
        return undefined;
    return Math.round(n * 60000);
}
function CronFormFields({ form, setForm, projects, modelConfig }: any) {
    const engineChoices = cronEngineChoices(modelConfig);
    const effEngine = effectiveCronEngine(form, projects);
    const modelOptions = modelsForCronEngine(modelConfig, effEngine);
    const defaultModel = defaultModelForCronEngine(modelConfig, effEngine);
    const inheritedHelper = inheritedCronEngineForHelper(form, projects);
    return (<>
      <TextInput value={form.name} onChangeText={(v: any) => setForm({ ...form, name: v })} placeholder="Name" placeholderTextColor={colors.gray500} style={styles.formInput}/>
      <TextInput value={form.schedule} onChangeText={(v: any) => setForm({ ...form, schedule: v })} placeholder="Cron schedule (e.g. */30 * * * *)" placeholderTextColor={colors.gray500} style={styles.formInput} autoCapitalize="none" autoCorrect={false}/>
      {form.schedule && humanCron(form.schedule) !== form.schedule && (<Text style={styles.cronPreview}>↳ {humanCron(form.schedule)}</Text>)}
      <TextInput value={form.prompt} onChangeText={(v: any) => setForm({ ...form, prompt: v })} placeholder="Prompt" placeholderTextColor={colors.gray500} style={[styles.formInput, { minHeight: 80 }]} multiline textAlignVertical="top"/>
      {projects.length > 0 && (<>
          <Text style={styles.fieldLabel}>Project</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <TouchableOpacity onPress={() => setForm({ ...form, project_id: '' })} style={[
                styles.projectChip,
                !form.project_id && styles.projectChipActive,
            ]}>
              <Text style={[
                styles.projectChipText,
                !form.project_id && styles.projectChipTextActive,
            ]}>
                No project
              </Text>
            </TouchableOpacity>
            {projects.map((p: any) => {
                const active = form.project_id === p.id;
                return (<TouchableOpacity key={p.id} onPress={() => setForm({
                        ...form,
                        project_id: p.id,
                        cwd: p.cwd || form.cwd,
                    })} style={[styles.projectChip, active && styles.projectChipActive]}>
                  <Text style={[
                        styles.projectChipText,
                        active && styles.projectChipTextActive,
                    ]}>
                    {p.name}
                  </Text>
                </TouchableOpacity>);
            })}
          </ScrollView>
        </>)}
      <TextInput value={form.cwd} onChangeText={(v: any) => setForm({ ...form, cwd: v })} placeholder="Working directory" placeholderTextColor={colors.gray500} style={styles.formInput} autoCapitalize="none" autoCorrect={false}/>
      <Text style={styles.fieldLabel}>
        Timeout (minutes) <Text style={{ color: colors.gray600 }}>— blank uses server default</Text>
      </Text>
      <TextInput value={form.timeoutMinutes} onChangeText={(v: any) => setForm({ ...form, timeoutMinutes: v })} placeholder="e.g. 30" placeholderTextColor={colors.gray500} style={styles.formInput} keyboardType="number-pad"/>
      {engineChoices.length > 0 && (<>
          <Text style={styles.fieldLabel}>
            Engine{' '}
            <Text style={{ color: colors.gray600 }}>
              — blank inherits from skill principal or falls back to claude-code
            </Text>
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <TouchableOpacity onPress={() => setForm({ ...form, engine: '', model: '' })} style={[
                styles.projectChip,
                !form.engine && styles.projectChipActive,
            ]} accessibilityLabel="Use default cron engine">
              <Text style={[
                styles.projectChipText,
                !form.engine && styles.projectChipTextActive,
            ]}>
                Default
              </Text>
            </TouchableOpacity>
            {engineChoices.map((eng: any) => {
                const active = form.engine === eng;
                return (<TouchableOpacity key={eng}
                // Switching engines clears any stale model so we never
                // POST a Claude id under a Cursor engine. The server
                // would reject it; clearing here makes the intent
                // obvious in the chip selection.
                onPress={() => setForm({ ...form, engine: eng, model: '' })} style={[styles.projectChip, active && styles.projectChipActive]}>
                  <Text style={[
                        styles.projectChipText,
                        active && styles.projectChipTextActive,
                    ]}>
                    {eng}
                  </Text>
                </TouchableOpacity>);
            })}
          </ScrollView>
          {inheritedHelper ? (<Text style={{ color: '#fbbf24', fontSize: 11, marginTop: 4 }}>
              Will run as {inheritedHelper} — inherited from skill principal.
            </Text>) : null}
        </>)}
      {modelOptions.length > 0 && (<>
          <Text style={styles.fieldLabel}>
            Model{' '}
            <Text style={{ color: colors.gray600 }}>
              — blank uses engine default{defaultModel ? ` (${defaultModel})` : ''}
            </Text>
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <TouchableOpacity onPress={() => setForm({ ...form, model: '' })} style={[
                styles.projectChip,
                !form.model && styles.projectChipActive,
            ]}>
              <Text style={[
                styles.projectChipText,
                !form.model && styles.projectChipTextActive,
            ]}>
                Default{defaultModel ? ` (${defaultModel})` : ''}
              </Text>
            </TouchableOpacity>
            {modelOptions.map((m: any) => {
                const active = form.model === m;
                return (<TouchableOpacity key={m} onPress={() => setForm({ ...form, model: m })} style={[styles.projectChip, active && styles.projectChipActive]}>
                  <Text style={[
                        styles.projectChipText,
                        active && styles.projectChipTextActive,
                    ]}>
                    {m}
                  </Text>
                </TouchableOpacity>);
            })}
          </ScrollView>
        </>)}
      <TouchableOpacity onPress={() => setForm({ ...form, notify_on_run: !form.notify_on_run })} style={styles.notifyToggleRow} accessibilityRole="checkbox" accessibilityState={{ checked: !!form.notify_on_run }}>
        <View style={[
            styles.notifyCheckbox,
            !!form.notify_on_run && styles.notifyCheckboxChecked,
        ]}>
          {!!form.notify_on_run && <Text style={styles.notifyCheckboxMark}>✓</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.notifyToggleLabel}>Send a push notification on every run</Text>
          <Text style={styles.notifyToggleHint}>
            Off by default — thread/heartbeat logs are written either way.
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setForm({ ...form, shared: !form.shared })} style={styles.notifyToggleRow} accessibilityRole="checkbox" accessibilityState={{ checked: !!form.shared }}>
        <View style={[
            styles.notifyCheckbox,
            !!form.shared && styles.notifyCheckboxChecked,
        ]}>
          {!!form.shared && <Text style={styles.notifyCheckboxMark}>✓</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.notifyToggleLabel}>Shared</Text>
          <Text style={styles.notifyToggleHint}>
            Visible to the org. Runs still use the owner credentials.
          </Text>
        </View>
      </TouchableOpacity>
    </>);
}
function CronSection() {
    const [projects, setProjects] = useState<any[]>([]);
    const defaultCwd = projects[0]?.cwd || '';
    const [crons, setCrons] = useState<any[]>([]);
    const [running, setRunning] = useState<any>({});
    const [showForm, setShowForm] = useState(false);
    const [cronLogs, setCronLogs] = useState<any>({});
    const [expandedLog, setExpandedLog] = useState<any>(null);
    const [editingId, setEditingId] = useState<any>(null);
    const [editForm, setEditForm] = useState<any>({});
    const [, setTick] = useState(0);
    const [modelConfig, setModelConfig] = useState<any>(null);
    const [form, setForm] = useState<any>({ name: '',
        schedule: '*/30 * * * *',
        prompt: '',
        cwd: '',
        project_id: '',
        enabled: true,
        timeoutMinutes: '',
        // Per-cron opt-in for "ran successfully" push notifications. Default
        // off — historically every cron pinged every device on every tick,
        // which mobile users complained about. Toggled per-cron from the form.
        notify_on_run: false,
        model: '',
        // Empty string = "inherit from skill principal agent at run time,
        // falling back to claude-code". Per-row engine override lets a
        // Codex/Cursor/Gemini cron run under its real engine instead of the
        // historical claude-code default.
        engine: '',
        shared: false,
    });
    const refreshLogs = async (cronList: any) => {
        const entries = await Promise.all((cronList || crons).map(async (c: any) => {
            try {
                const logs = await api.getCronLogs(c.id, 3);
                return [c.id, logs];
            }
            catch {
                return [c.id, []];
            }
        }));
        setCronLogs(Object.fromEntries(entries));
    };
    useEffect(() => {
        const refresh = async () => {
            try {
                const data = await api.getCrons();
                setCrons(data);
                await refreshLogs(data);
            }
            catch (e: any) {
                console.error(e);
            }
        };
        refresh();
        const pollId = setInterval(refresh, 60000);
        const tickId = setInterval(() => setTick((t: any) => t + 1), 30000);
        // Hydrate model dropdown from the server's engineValidModels.
        api.getModelConfig().then(setModelConfig).catch(() => { });
        return () => {
            clearInterval(pollId);
            clearInterval(tickId);
        };
    }, []);
    useEffect(() => {
        api.getProjects().then(setProjects).catch(() => setProjects([]));
    }, []);
    // Seed the create-form's cwd/project with the first project once they load.
    useEffect(() => {
        if (projects.length > 0 && !form.project_id && !form.cwd) {
            setForm((f: any) => ({
                ...f,
                project_id: projects[0].id,
                cwd: projects[0].cwd || '',
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projects]);
    const toggleCron = async (cronJob: any) => {
        const updated = await api.updateCron(cronJob.id, { enabled: !cronJob.enabled });
        setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
    };
    const triggerRun = async (id: any) => {
        setRunning((prev: any) => ({ ...prev, [id]: true }));
        try {
            await api.runCron(id);
        }
        catch (e: any) {
            console.error(e);
        }
        setTimeout(() => setRunning((prev: any) => ({ ...prev, [id]: false })), 3000);
    };
    const deleteCron = async (id: any) => {
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
    const createCron = async () => {
        if (!form.name || !form.schedule || !form.prompt) {
            Alert.alert('Missing fields', 'Name, schedule, and prompt are required.');
            return;
        }
        const timeout_ms = minutesToTimeoutMs(form.timeoutMinutes);
        if (timeout_ms === undefined) {
            Alert.alert('Invalid timeout', 'Timeout must be a positive number of minutes.');
            return;
        }
        const payload = { ...form, timeout_ms };
        delete (payload as any).timeoutMinutes;
        try {
            const created = await api.createCron(payload);
            setCrons((prev: any) => [...prev, created]);
            setShowForm(false);
            setForm({
                name: '',
                schedule: '*/30 * * * *',
                prompt: '',
                cwd: defaultCwd,
                project_id: projects[0]?.id || '',
                enabled: true,
                timeoutMinutes: '',
                notify_on_run: false,
                model: '',
                engine: '',
                shared: false,
            });
        }
        catch (e: any) {
            Alert.alert('Create failed', e?.message || 'Could not create cron.');
        }
    };
    const startEditing = (cronJob: any) => {
        setEditingId(cronJob.id);
        setEditForm({
            name: cronJob.name,
            schedule: cronJob.schedule,
            prompt: cronJob.prompt,
            cwd: cronJob.cwd || '',
            project_id: cronJob.project_id || '',
            timeoutMinutes: cronJob.timeout_ms
                ? String(Math.round(cronJob.timeout_ms / 60000))
                : '',
            notify_on_run: !!cronJob.notify_on_run,
            shared: !!cronJob.shared,
            // Null in the DB = "use engine default" — render as the empty option.
            model: cronJob.model || '',
            engine: cronJob.engine || '',
            // Stash the principal id so the helper text can compute the
            // inherited engine. Stripped from the PUT payload in saveEdit so
            // the server preserves the existing value (present-key tristate).
            skill_principal_agent_id: cronJob.skill_principal_agent_id || '',
        });
    };
    const saveEdit = async () => {
        if (!editForm.name || !editForm.schedule || !editForm.prompt) {
            Alert.alert('Missing fields', 'Name, schedule, and prompt are required.');
            return;
        }
        const timeout_ms = minutesToTimeoutMs(editForm.timeoutMinutes);
        if (timeout_ms === undefined) {
            Alert.alert('Invalid timeout', 'Timeout must be a positive number of minutes.');
            return;
        }
        const payload = { ...editForm, timeout_ms };
        delete (payload as any).timeoutMinutes;
        // skill_principal_agent_id is stashed in editForm purely so the helper
        // text can compute inherited-engine display — it's not editable from
        // the cron form. Omitting it from the PUT payload preserves the
        // existing DB value (the server's present-key tristate).
        delete (payload as any).skill_principal_agent_id;
        try {
            const updated = await api.updateCron(editingId, payload);
            setCrons((prev: any) => prev.map((c: any) => (c.id === updated.id ? updated : c)));
            setEditingId(null);
            setEditForm({});
        }
        catch (e: any) {
            Alert.alert('Save failed', e?.message || 'Could not save cron.');
        }
    };
    const renderNextRunBadge = (cronJob: any) => {
        if (!cronJob.enabled || !cronJob.next_run_at)
            return null;
        const { label, overdue } = relativeFuture(cronJob.next_run_at);
        if (!label)
            return null;
        return (<View style={[styles.nextRunBadge, overdue && styles.nextRunBadgeOverdue]}>
        <Text style={[styles.nextRunBadgeText, overdue && styles.nextRunBadgeTextOverdue]}>
          {label}
        </Text>
      </View>);
    };
    return (<View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Cron Jobs</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowForm(!showForm)}>
          <Text style={styles.headerButtonText}>{showForm ? 'Cancel' : '+ New Cron'}</Text>
        </TouchableOpacity>
      </View>

      {showForm && (<View style={styles.formCard}>
          <CronFormFields form={form} setForm={setForm} projects={projects} modelConfig={modelConfig}/>
          <TouchableOpacity style={styles.createButton} onPress={createCron}>
            <Text style={styles.createButtonText}>Create</Text>
          </TouchableOpacity>
        </View>)}

      <View style={styles.cardList}>
        {crons.map((cronJob: any) => (<View key={cronJob.id} style={styles.card}>
            {editingId === cronJob.id ? (<View style={styles.editForm}>
                <CronFormFields form={editForm} setForm={setEditForm} projects={projects} modelConfig={modelConfig}/>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity style={styles.primaryBtn} onPress={saveEdit}>
                    <Text style={styles.primaryBtnText}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => {
                    setEditingId(null);
                    setEditForm({});
                }}>
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>) : (<View style={styles.cardRow}>
              <View style={styles.cardInfo}>
                <View style={styles.row}>
                  <Text style={styles.cardName}>{cronJob.name}</Text>
                  <Text style={styles.mono}>{humanCron(cronJob.schedule)}</Text>
                  <Text style={styles.ownerBadge}>{cronJob.shared ? 'Shared' : 'Private'}</Text>
                  {!!cronJob.owner_username && (
                    <Text style={styles.ownerBadge}>Owner: {cronJob.owner_username}</Text>
                  )}
                  {renderNextRunBadge(cronJob)}
                </View>
                <Text style={styles.cardSubtext} numberOfLines={1}>
                  {cronJob.prompt}
                </Text>
                <Text style={styles.cardMeta}>
                  cwd: {cronJob.cwd}
                  {cronJob.timeout_ms
                    ? ` · Timeout: ${Math.round(cronJob.timeout_ms / 60000)}m`
                    : ''}
                  {cronJob.engine ? ` · Engine: ${cronJob.engine}` : ''}
                  {cronJob.model ? ` · Model: ${cronJob.model}` : ''}
                  {cronJob.notify_on_run ? ' · Notifies on run' : ''}
                  {cronJob.last_run && ` · Last: ${relativeTime(cronJob.last_run)}`}
                </Text>
                {/* Recent runs — clickable status dots */}
                {cronLogs[cronJob.id]?.length > 0 && (<View style={{ marginTop: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 11, color: colors.gray500 }}>Runs:</Text>
                      {cronLogs[cronJob.id].map((log: any) => {
                        const key = `${cronJob.id}:${log.id}`;
                        const isExpanded = expandedLog === key;
                        const dotColor = log.status === 'success' ? '#10b981' :
                            log.status === 'error' ? '#ef4444' :
                                log.status === 'running' ? '#fbbf24' : '#6b7280';
                        return (<TouchableOpacity key={log.id} onPress={() => setExpandedLog(isExpanded ? null : key)} style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 4,
                                paddingHorizontal: 6,
                                paddingVertical: 3,
                                borderRadius: 4,
                                backgroundColor: isExpanded ? colors.gray700 : colors.gray800,
                                borderWidth: isExpanded ? 1 : 0,
                                borderColor: colors.gray600,
                            }}>
                            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor }}/>
                            <Text style={{ fontSize: 10, color: colors.gray400 }}>
                              {relativeTime(log.timestamp)}
                            </Text>
                          </TouchableOpacity>);
                    })}
                    </View>
                    {cronLogs[cronJob.id].map((log: any) => {
                        const key = `${cronJob.id}:${log.id}`;
                        if (expandedLog !== key)
                            return null;
                        return (<View key={`detail-${log.id}`} style={{
                                marginTop: 8,
                                backgroundColor: colors.gray900,
                                borderRadius: 8,
                                padding: 10,
                                borderWidth: 1,
                                borderColor: colors.gray700,
                            }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text style={{
                                fontSize: 11,
                                fontWeight: '600',
                                color: log.status === 'success' ? '#10b981' :
                                    log.status === 'error' ? '#ef4444' :
                                        log.status === 'running' ? '#fbbf24' : colors.gray400,
                            }}>
                                {log.status === 'success' ? '✓ Success' :
                                log.status === 'error' ? '✗ Error' :
                                    log.status === 'running' ? 'Running' : log.status}
                              </Text>
                              <Text style={{ fontSize: 10, color: colors.gray500 }}>
                                {new Date(log.timestamp).toLocaleString()}
                              </Text>
                              {log.duration_ms != null && (<Text style={{ fontSize: 10, color: colors.gray500, fontFamily: 'monospace' }}>
                                  {(log.duration_ms / 1000).toFixed(1)}s
                                </Text>)}
                            </View>
                            <TouchableOpacity onPress={() => setExpandedLog(null)}>
                              <Text style={{ fontSize: 11, color: colors.gray500 }}>✕</Text>
                            </TouchableOpacity>
                          </View>
                          {log.result ? (<ScrollView style={{ maxHeight: 160 }}>
                              <Text style={{ fontSize: 11, color: colors.gray400, fontFamily: 'monospace' }}>
                                {log.result}
                              </Text>
                            </ScrollView>) : (<Text style={{ fontSize: 11, color: colors.gray600, fontStyle: 'italic' }}>
                              No output yet
                            </Text>)}
                        </View>);
                    })}
                  </View>)}
              </View>
              <View style={styles.actionButtons}>
                <TouchableOpacity style={[styles.smallButton, !cronJob.can_manage && styles.disabledButton]} onPress={() => startEditing(cronJob)} disabled={!cronJob.can_manage} accessibilityLabel="Edit cron">
                  <Text style={styles.smallButtonText}>✎</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.smallButton, (!cronJob.can_manage || running[cronJob.id]) && styles.disabledButton]} onPress={() => triggerRun(cronJob.id)} disabled={!cronJob.can_manage || running[cronJob.id]}>
                  <Text style={styles.smallButtonText}>
                    {running[cronJob.id] ? '...' : 'Run'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={[
                    styles.smallButton,
                    cronJob.enabled ? styles.buttonOn : styles.buttonOff,
                    !cronJob.can_manage && styles.disabledButton,
                ]} onPress={() => toggleCron(cronJob)} disabled={!cronJob.can_manage}>
                  <Text style={[
                    styles.smallButtonText,
                    cronJob.enabled ? styles.buttonOnText : styles.buttonOffText,
                ]}>
                    {cronJob.enabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.smallButton, !cronJob.can_manage && styles.disabledButton]} onPress={() => deleteCron(cronJob.id)} disabled={!cronJob.can_manage}>
                  <Text style={styles.deleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>)}
          </View>))}
        {crons.length === 0 && (<Text style={styles.emptyText}>No cron jobs configured</Text>)}
      </View>
    </View>);
}
// ─── Slack Tab ──────────────────────────────────────────────
function SlackSection() {
    const [status, setStatus] = useState<any[]>([]);
    const [messages, setMessages] = useState<any[]>([]);
    const [restarting, setRestarting] = useState(false);
    const [selectedAgent, setSelectedAgent] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const loadStatus = async () => {
        try {
            const data = await api.getSlackStatus();
            setStatus(data);
        }
        catch {
            // ignore
        }
        finally {
            setLoading(false);
        }
    };
    const loadMessages = async (agentId?: any) => {
        if (!agentId) {
            setMessages([]);
            return;
        }
        try {
            const data = await api.getSlackMessages(agentId, 20);
            setMessages(data);
        }
        catch {
            // ignore
        }
    };
    useEffect(() => {
        loadStatus();
        loadMessages();
    }, []);
    const handleRestart = async () => {
        setRestarting(true);
        try {
            await api.restartSlack();
            await loadStatus();
        }
        catch {
            // ignore
        }
        finally {
            setRestarting(false);
        }
    };
    if (loading) {
        return <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 40 }}/>;
    }
    return (<View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Slack Bots</Text>
        <TouchableOpacity style={styles.headerButton} onPress={handleRestart} disabled={restarting}>
          <Text style={styles.headerButtonText}>
            {restarting ? 'Restarting...' : 'Restart All'}
          </Text>
        </TouchableOpacity>
      </View>

      {status.length === 0 ? (<Text style={styles.emptyText}>No Slack accounts configured</Text>) : (<View style={styles.cardList}>
          {status.map((bot: any) => (<TouchableOpacity key={bot.name} style={styles.card} onPress={() => {
                    if (selectedAgent === bot.agentId) {
                        setSelectedAgent(null);
                        loadMessages();
                    }
                    else {
                        setSelectedAgent(bot.agentId);
                        loadMessages(bot.agentId);
                    }
                }}>
              <View style={styles.cardRow}>
                <View style={[
                    styles.dot,
                    { backgroundColor: bot.connected ? colors.emerald400 : colors.red400 },
                ]}/>
                <View style={styles.cardInfo}>
                  <View style={styles.row}>
                    <Text style={styles.cardName}>{bot.name}</Text>
                    <View style={styles.agentIdBadge}>
                      <Text style={styles.agentIdText}>→ {bot.agentId}</Text>
                    </View>
                  </View>
                  {bot.error && <Text style={styles.errorText}>{bot.error}</Text>}
                  {bot.lastMessage && (<Text style={styles.cardMeta}>
                      Last message: {relativeTime(bot.lastMessage)}
                    </Text>)}
                </View>
                <View style={[
                    styles.statusPill,
                    bot.connected ? styles.statusPillConnected : styles.statusPillDisconnected,
                ]}>
                  <Text style={[
                    styles.statusPillText,
                    bot.connected ? styles.statusPillTextConnected : styles.statusPillTextDisconnected,
                ]}>
                    {bot.connected ? 'Connected' : 'Disconnected'}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>))}
        </View>)}

      {/* Recent messages */}
      <View style={styles.messagesSection}>
        <Text style={styles.messagesTitle}>
          Recent Messages{selectedAgent ? ` (${selectedAgent})` : ''}
        </Text>
        {messages.length === 0 ? (<Text style={styles.emptyLogsText}>No messages yet</Text>) : (messages.map((msg: any) => (<View key={msg.id} style={styles.slackMessage}>
              <View style={styles.row}>
                <Text style={styles.mono}>{msg.agent_id}</Text>
                <Text style={styles.cardMeta}>{relativeTime(msg.timestamp)}</Text>
              </View>
              <Text style={styles.slackUserMsg} numberOfLines={3}>
                User: {msg.user_message?.substring(0, 200)}
              </Text>
              <Text style={styles.slackBotMsg} numberOfLines={4}>
                Bot: {msg.bot_response?.substring(0, 300)}
              </Text>
            </View>)))}
      </View>
    </View>);
}
// ─── Agent Config Tab ───────────────────────────────────────
function AgentConfigSection() {
    const { agents: contextAgents, refreshAgents } = useApp();
    const [agents, setAgents] = useState(contextAgents);
    const [expanded, setExpanded] = useState<any>(null);
    const [saving, setSaving] = useState<any>({});
    const [saveStatus, setSaveStatus] = useState<any>({});
    const [edits, setEdits] = useState<any>({});
    const [showNew, setShowNew] = useState(false);
    const [modelConfig, setModelConfig] = useState<any>(null);
    const [bulkEngine, setBulkEngine] = useState('claude-code');
    const [bulkModel, setBulkModel] = useState('');
    const [bulkSaving, setBulkSaving] = useState(false);
    const [newForm, setNewForm] = useState({
        id: '',
        name: '',
        engine: 'claude-code',
        model: '',
        cwd: '/home/ryan',
        workspace: '',
        color: '#6b7280',
        systemPrompt: '',
    });
    useEffect(() => {
        setAgents(contextAgents);
    }, [contextAgents]);
    useEffect(() => {
        api.getModelConfig().then(setModelConfig).catch(() => { });
    }, []);
    const getModelsForEngine = (engine: any) => {
        if (!modelConfig)
            return [];
        return modelConfig.engineValidModels[engine] || [];
    };
    const getDefaultModel = (engine: any) => {
        if (!modelConfig)
            return '';
        return modelConfig.engineDefaultModels[engine] || modelConfig.defaultModel || '';
    };
    const engineChoices = useMemo<any>(() => {
        if (!modelConfig)
            return [];
        return Object.keys(modelConfig.engineValidModels).filter((e: any) => (modelConfig.engineValidModels[e]?.length ?? 0) > 0);
    }, [modelConfig]);
    useEffect(() => {
        if (engineChoices.length === 0)
            return;
        if (!engineChoices.includes(bulkEngine)) {
            setBulkEngine(engineChoices[0]);
            setBulkModel('');
        }
    }, [engineChoices, bulkEngine]);
    const handleBulkApplyAll = () => {
        if (!modelConfig || agents.length === 0)
            return;
        const effectiveModel = bulkModel || getDefaultModel(bulkEngine);
        Alert.alert('Switch all agents', `Set every agent to ${bulkEngine} / ${effectiveModel}?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Apply',
                style: 'default',
                onPress: async () => {
                    setBulkSaving(true);
                    try {
                        await api.bulkSetAllAgentsEngine({ engine: bulkEngine, model: effectiveModel });
                        setEdits({});
                        refreshAgents();
                    }
                    catch (e: any) {
                        const msg = e instanceof Error ? e.message : 'Bulk update failed.';
                        Alert.alert('Error', msg);
                    }
                    finally {
                        setBulkSaving(false);
                    }
                },
            },
        ]);
    };
    const getEdit = (agentId: any) => {
        if (edits[agentId])
            return edits[agentId];
        return agents.find((a: any) => a.id === agentId) || {};
    };
    const setEdit = (agentId: any, field: any, value: any) => {
        setEdits((prev: any) => ({
            ...prev,
            [agentId]: { ...(prev[agentId] || agents.find((a: any) => a.id === agentId)), [field]: value },
        }));
    };
    const handleSave = async (agentId: any) => {
        setSaving((prev: any) => ({ ...prev, [agentId]: true }));
        try {
            const data = edits[agentId];
            if (!data)
                return;
            const { id, lastActivity, lastMessage, ...payload } = data;
            await api.updateAgent(agentId, payload);
            setEdits((prev: any) => {
                const n = { ...prev };
                delete (n as any)[agentId];
                return n;
            });
            setSaveStatus((prev: any) => ({ ...prev, [agentId]: 'saved' }));
            refreshAgents();
            setTimeout(() => setSaveStatus((prev: any) => ({ ...prev, [agentId]: null })), 2000);
        }
        catch {
            setSaveStatus((prev: any) => ({ ...prev, [agentId]: 'error' }));
            setTimeout(() => setSaveStatus((prev: any) => ({ ...prev, [agentId]: null })), 3000);
        }
        finally {
            setSaving((prev: any) => ({ ...prev, [agentId]: false }));
        }
    };
    const handleCreate = async () => {
        if (!newForm.id) {
            Alert.alert('Missing ID', 'Agent ID is required.');
            return;
        }
        try {
            await api.createAgent(newForm);
            setShowNew(false);
            setNewForm({ id: '', name: '', engine: 'claude-code', model: '', cwd: '/home/ryan', workspace: '', color: '#6b7280', systemPrompt: '' });
            refreshAgents();
        }
        catch (e: any) {
            Alert.alert('Error', 'Failed to create agent.');
        }
    };
    const handleDelete = (agentId: any) => {
        Alert.alert('Delete Agent', 'Are you sure? This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    await api.deleteAgent(agentId);
                    refreshAgents();
                    setExpanded(null);
                },
            },
        ]);
    };
    return (<View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Agent Configurations</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowNew(!showNew)}>
          <Text style={styles.headerButtonText}>{showNew ? 'Cancel' : '+ New Agent'}</Text>
        </TouchableOpacity>
      </View>

      {agents.length > 0 && modelConfig && (<View style={[styles.formCard, { marginBottom: 12 }]}>
          <Text style={styles.fieldLabel}>Switch all agents</Text>
          <Text style={[styles.cardMeta, { marginBottom: 8 }]}>
            Bulk engine + model (for example when a subscription ends).
          </Text>
          <Text style={styles.fieldLabel}>Engine</Text>
          <View style={styles.engineToggle}>
            {engineChoices.map((eng: any) => (<TouchableOpacity key={eng} style={[
                    styles.engineOption,
                    bulkEngine === eng && styles.engineOptionActive,
                ]} onPress={() => {
                    setBulkEngine(eng);
                    setBulkModel('');
                }}>
                <Text style={[
                    styles.engineOptionText,
                    bulkEngine === eng && styles.engineOptionTextActive,
                ]} numberOfLines={1}>
                  {eng.replace('-code', '').replace('-cli', '').replace('-agent', '')}
                </Text>
              </TouchableOpacity>))}
          </View>
          <Text style={styles.fieldLabel}>Model</Text>
          <View style={styles.engineToggle}>
            {getModelsForEngine(bulkEngine).map((m: any) => (<TouchableOpacity key={m} style={[
                    styles.engineOption,
                    (bulkModel || getDefaultModel(bulkEngine)) === m && styles.engineOptionActive,
                ]} onPress={() => setBulkModel(m)}>
                <Text style={[
                    styles.engineOptionText,
                    (bulkModel || getDefaultModel(bulkEngine)) === m && styles.engineOptionTextActive,
                ]}>
                  {m.replace(/^claude-/, '').replace(/^gpt-/, '')}
                </Text>
              </TouchableOpacity>))}
          </View>
          <TouchableOpacity style={[styles.createButton, bulkSaving && { opacity: 0.6 }]} disabled={bulkSaving} onPress={handleBulkApplyAll}>
            <Text style={styles.createButtonText}>{bulkSaving ? 'Applying…' : 'Apply to all'}</Text>
          </TouchableOpacity>
        </View>)}

      {showNew && (<View style={styles.formCard}>
          <TextInput value={newForm.id} onChangeText={(v: any) => setNewForm({ ...newForm, id: v })} placeholder="ID (alphanumeric + hyphens)" placeholderTextColor={colors.gray500} style={styles.formInput} autoCapitalize="none"/>
          <TextInput value={newForm.name} onChangeText={(v: any) => setNewForm({ ...newForm, name: v })} placeholder="Name" placeholderTextColor={colors.gray500} style={styles.formInput}/>
          <TextInput value={newForm.cwd} onChangeText={(v: any) => setNewForm({ ...newForm, cwd: v })} placeholder="Working Directory" placeholderTextColor={colors.gray500} style={styles.formInput}/>
          <TextInput value={newForm.workspace} onChangeText={(v: any) => setNewForm({ ...newForm, workspace: v })} placeholder="Workspace" placeholderTextColor={colors.gray500} style={styles.formInput}/>
          <Text style={styles.fieldLabel}>Engine</Text>
          <View style={styles.engineToggle}>
            {engineChoices.map((eng: any) => (<TouchableOpacity key={eng} style={[
                    styles.engineOption,
                    newForm.engine === eng && styles.engineOptionActive,
                ]} onPress={() => setNewForm({ ...newForm, engine: eng, model: '' })}>
                <Text style={[
                    styles.engineOptionText,
                    newForm.engine === eng && styles.engineOptionTextActive,
                ]} numberOfLines={1}>
                  {eng}
                </Text>
              </TouchableOpacity>))}
          </View>
          <Text style={styles.fieldLabel}>Model</Text>
          <View style={styles.engineToggle}>
            {getModelsForEngine(newForm.engine).map((m: any) => (<TouchableOpacity key={m} style={[
                    styles.engineOption,
                    (newForm.model || getDefaultModel(newForm.engine)) === m && styles.engineOptionActive,
                ]} onPress={() => setNewForm({ ...newForm, model: m })}>
                <Text style={[
                    styles.engineOptionText,
                    (newForm.model || getDefaultModel(newForm.engine)) === m && styles.engineOptionTextActive,
                ]}>
                  {m.replace(/^claude-/, '').replace(/^gpt-/, '')}
                </Text>
              </TouchableOpacity>))}
          </View>
          <TextInput value={newForm.systemPrompt} onChangeText={(v: any) => setNewForm({ ...newForm, systemPrompt: v })} placeholder="System Prompt" placeholderTextColor={colors.gray500} style={[styles.formInput, { minHeight: 80 }]} multiline textAlignVertical="top"/>
          <TouchableOpacity style={styles.createButton} onPress={handleCreate}>
            <Text style={styles.createButtonText}>Create Agent</Text>
          </TouchableOpacity>
        </View>)}

      <View style={styles.cardList}>
        {agents.map((agent: any) => {
            const isExpanded = expanded === agent.id;
            const edit = getEdit(agent.id);
            const isDirty = !!edits[agent.id];
            return (<View key={agent.id} style={styles.card}>
              <TouchableOpacity style={styles.cardRow} onPress={() => setExpanded(isExpanded ? null : agent.id)}>
                <View style={[styles.dot, { backgroundColor: agent.color }]}/>
                <View style={styles.cardInfo}>
                  <View style={styles.row}>
                    <Text style={styles.cardName}>{agent.name}</Text>
                    <Text style={styles.mono}>{agent.id}</Text>
                    <Text style={styles.cardMeta}>{agent.engine}</Text>
                  </View>
                  <Text style={[styles.cardMeta, styles.mono]} numberOfLines={1}>
                    {agent.cwd}
                  </Text>
                </View>
                <View style={styles.row}>
                  {saveStatus[agent.id] === 'saved' && (<Text style={styles.statusSuccess}>✓ Saved</Text>)}
                  <Text style={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</Text>
                </View>
              </TouchableOpacity>

              {isExpanded && (<View style={styles.expandedSection}>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput value={edit.name || ''} onChangeText={(v: any) => setEdit(agent.id, 'name', v)} style={styles.formInput}/>

                  <Text style={styles.fieldLabel}>Engine</Text>
                  <View style={styles.engineToggle}>
                    {engineChoices.map((eng: any) => (<TouchableOpacity key={eng} style={[
                            styles.engineOption,
                            (edit.engine || agent.engine || 'claude-code') === eng &&
                                styles.engineOptionActive,
                        ]} onPress={() => {
                            setEdit(agent.id, 'engine', eng);
                            setEdit(agent.id, 'model', getDefaultModel(eng));
                        }}>
                        <Text style={[
                            styles.engineOptionText,
                            (edit.engine || agent.engine || 'claude-code') === eng &&
                                styles.engineOptionTextActive,
                        ]} numberOfLines={1}>
                          {eng}
                        </Text>
                      </TouchableOpacity>))}
                  </View>

                  <Text style={styles.fieldLabel}>Model</Text>
                  <View style={styles.engineToggle}>
                    {getModelsForEngine(edit.engine || agent.engine || 'claude-code').map((m: any) => (<TouchableOpacity key={m} style={[
                            styles.engineOption,
                            (edit.model || agent.model || getDefaultModel(edit.engine || agent.engine || 'claude-code')) === m && styles.engineOptionActive,
                        ]} onPress={() => setEdit(agent.id, 'model', m)}>
                        <Text style={[
                            styles.engineOptionText,
                            (edit.model || agent.model || getDefaultModel(edit.engine || agent.engine || 'claude-code')) === m && styles.engineOptionTextActive,
                        ]}>
                          {m.replace(/^claude-/, '').replace(/^gpt-/, '')}
                        </Text>
                      </TouchableOpacity>))}
                  </View>

                  <Text style={styles.fieldLabel}>Working Directory</Text>
                  <TextInput value={edit.cwd || ''} onChangeText={(v: any) => setEdit(agent.id, 'cwd', v)} style={styles.formInput}/>

                  <Text style={styles.fieldLabel}>Workspace</Text>
                  <TextInput value={edit.workspace || ''} onChangeText={(v: any) => setEdit(agent.id, 'workspace', v)} style={styles.formInput}/>

                  <Text style={styles.fieldLabel}>System Prompt</Text>
                  <TextInput value={edit.systemPrompt || ''} onChangeText={(v: any) => setEdit(agent.id, 'systemPrompt', v)} style={[styles.formInput, { minHeight: 100 }]} multiline textAlignVertical="top"/>

                  <View style={styles.expandedActions}>
                    <TouchableOpacity onPress={() => handleDelete(agent.id)} style={styles.deleteButton}>
                      <Text style={styles.deleteButtonText}>Delete Agent</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleSave(agent.id)} disabled={!isDirty || saving[agent.id]} style={[styles.saveAgentButton, (!isDirty || saving[agent.id]) && { opacity: 0.5 }]}>
                      <Text style={styles.saveAgentButtonText}>
                        {saving[agent.id] ? 'Saving...' : 'Save'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>)}
            </View>);
        })}
        {agents.length === 0 && (<Text style={styles.emptyText}>No agents configured</Text>)}
      </View>
    </View>);
}
// ─── Projects Tab ────────────────────────────────────────────
function ProjectsSection() {
    const { projects, refreshProjects } = useApp();
    const [saving, setSaving] = useState<any>({});
    const handleModeChange = async (projectId: any, mode: any) => {
        setSaving((prev: any) => ({ ...prev, [projectId]: true }));
        try {
            await api.updateProject(projectId, { mode });
            refreshProjects();
        }
        catch (e: any) {
            Alert.alert('Error', e?.message || 'Failed to update project mode');
        }
        finally {
            setSaving((prev: any) => ({ ...prev, [projectId]: false }));
        }
    };
    if (!projects || projects.length === 0) {
        return (<View>
        <Text style={styles.sectionTitle}>Projects</Text>
        <Text style={styles.emptyText}>No projects configured</Text>
      </View>);
    }
    return (<View>
      <Text style={styles.sectionTitle}>Projects</Text>
      <Text style={styles.sectionDesc}>
        Dev (default): kanban lifecycle, per-session worktrees, and GitHub PR review automation.
        Workflow: work in the project checkout; automated reviewer dispatch and session PR flows
        stay off.
      </Text>
      {projects.map((project: any) => (<View key={project.id} style={styles.formCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: project.color || '#6366f1' }}/>
            <Text style={[styles.fieldLabel, { marginBottom: 0, flex: 1 }]}>{project.name}</Text>
            {saving[project.id] && <ActivityIndicator size="small" color={colors.gray400}/>}
          </View>
          <Text style={[styles.fieldLabel, { marginBottom: 6 }]}>Mode</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {['dev', 'workflow'].map((mode: any) => {
                const active = (project.mode || 'dev') === mode;
                return (<TouchableOpacity key={mode} style={[styles.smallButton, active ? styles.buttonOn : styles.buttonOff]} onPress={() => !active && handleModeChange(project.id, mode)} disabled={saving[project.id]}>
                  <Text style={[styles.smallButtonText, active ? styles.buttonOnText : styles.buttonOffText]}>
                    {mode === 'dev' ? 'Dev' : 'Workflow'}
                  </Text>
                </TouchableOpacity>);
            })}
          </View>
        </View>))}
    </View>);
}
// ─── Main Settings Screen ───────────────────────────────────
// Tab list mirrors the web Settings page (`SettingsPage.jsx` SETTINGS_TABS).
// Per-project items (agents, crons, heartbeats, runners, secrets) live under
// each project's Settings submenu in the drawer — not here.
// Mobile adds Notifications (native push) and Servers (org bookmarks).
const SETTINGS_TABS = [
    { id: 'notifications', label: 'Notifications' },
    { id: 'general', label: 'General' },
    { id: 'servers', label: 'Servers' },
    { id: 'account', label: 'Account' },
    { id: 'global-api-keys', label: 'Global API Keys' },
    { id: 'github', label: 'GitHub' },
    { id: 'slack', label: 'Slack' },
    { id: 'usage', label: 'Usage' },
    { id: 'tool-errors', label: 'Tool Errors' },
    { id: 'backup', label: 'Backup' },
    { id: 'logs', label: 'Logs' },
];
/** Legacy tab ids that moved to per-project settings — fall back to General. */
const LEGACY_TAB_IDS = new Set([
    'orgs',
    'heartbeats',
    'crons',
    'projects',
    'secrets',
    'agents',
    'mykeys',
    'finalize',
    'config',
    'preview',
]);
const SETTINGS_TAB_IDS = SETTINGS_TABS.map((t: any) => t.id);
export default function SettingsScreen({ route }: any) {
    const { openSidebar } = useContext(SidebarContext);
    const routeTab = route?.params?.tab;
    const [tab, setTab] = useState(() => normalizeSettingsTab(routeTab, SETTINGS_TAB_IDS, LEGACY_TAB_IDS));
    const [tabMenuOpen, setTabMenuOpen] = useState(false);
    // React Navigation keeps SettingsScreen mounted, so the `useState`
    // initializer above only runs once. When the screen is re-navigated with a
    // new `tab` param while already open (e.g. the dashboard "Account"
    // shortcut), apply the same normalization so the tab actually switches.
    useEffect(() => {
        if (!routeTab)
            return;
        setTab(normalizeSettingsTab(routeTab, SETTINGS_TAB_IDS, LEGACY_TAB_IDS));
    }, [routeTab]);
    const activeTab = useMemo<any>(() => SETTINGS_TABS.find((t: any) => t.id === tab) ?? SETTINGS_TABS[1], [tab]);
    const selectTab = (tabId: any) => {
        setTab(tabId);
        setTabMenuOpen(false);
    };
    return (<SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton} accessibilityLabel="Open menu">
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Settings</Text>
        <TouchableOpacity style={styles.tabDropdown} onPress={() => setTabMenuOpen(true)} accessibilityLabel="Select settings section" accessibilityHint="Opens a menu of settings sections" testID="settings-tab-dropdown">
          <Text style={styles.tabDropdownText} numberOfLines={1}>
            {activeTab.label}
          </Text>
          <HubIcon name="ChevronDown" size={14} color={colors.gray400}/>
        </TouchableOpacity>
      </View>

      <Modal visible={tabMenuOpen} transparent animationType="fade" onRequestClose={() => setTabMenuOpen(false)}>
        <Pressable style={styles.tabMenuBackdrop} onPress={() => setTabMenuOpen(false)}>
          <View style={styles.tabMenu}>
            <ScrollView keyboardShouldPersistTaps="handled">
              {SETTINGS_TABS.map((t: any) => {
            const active = tab === t.id;
            return (<TouchableOpacity key={t.id} style={[styles.tabMenuItem, active && styles.tabMenuItemActive]} onPress={() => selectTab(t.id)} testID={`settings-tab-${t.id}`}>
                    <Text style={[styles.tabMenuItemText, active && styles.tabMenuItemTextActive]}>
                      {t.label}
                    </Text>
                    {active ? <Text style={styles.tabMenuCheck}>{'\u2713'}</Text> : null}
                  </TouchableOpacity>);
        })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {tab === 'notifications' && <PushNotificationsSection />}
          {tab === 'general' && <GeneralSettingsSection />}
          {tab === 'servers' && <OrganizationsSection />}
          {tab === 'account' && <AccountSection />}
          {tab === 'global-api-keys' && <GlobalApiKeysSection />}
          {tab === 'github' && <GitHubSettingsSection />}
          {tab === 'usage' && <UsageSection />}
          {tab === 'slack' && (<>
              <SlackBotsSection />
              <SlackSection />
            </>)}
          {tab === 'tool-errors' && <ToolErrorsSection />}
          {tab === 'backup' && <ConfigBackupSection />}
          {tab === 'logs' && <ServerLogsSection />}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: colors.gray950,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: {
        padding: 4,
    },
    menuIcon: {
        fontSize: 22,
        color: colors.gray400,
    },
    topBarTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: colors.white,
        flex: 1,
    },
    tabDropdown: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: '52%',
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        backgroundColor: colors.gray900,
    },
    tabDropdownText: {
        flex: 1,
        fontSize: 14,
        color: colors.gray200,
        fontWeight: '500',
    },
    tabMenuBackdrop: {
        flex: 1,
        backgroundColor: colors.black50,
        paddingTop: 56,
        paddingHorizontal: 12,
        alignItems: 'flex-end',
    },
    tabMenu: {
        width: '100%',
        maxWidth: 320,
        maxHeight: '80%',
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray800,
        borderRadius: 12,
        overflow: 'hidden',
    },
    tabMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.gray800,
    },
    tabMenuItemActive: {
        backgroundColor: colors.gray800,
    },
    tabMenuItemText: {
        fontSize: 15,
        color: colors.gray300,
    },
    tabMenuItemTextActive: {
        color: colors.white,
        fontWeight: '600',
    },
    tabMenuCheck: {
        color: colors.blue400,
        fontSize: 14,
        fontWeight: '700',
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
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.white,
        marginBottom: 12,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    headerButton: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
    },
    headerButtonText: {
        fontSize: 12,
        color: colors.gray300,
    },
    cardList: {
        gap: 8,
    },
    card: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        overflow: 'hidden',
    },
    cardRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 14,
    },
    dot: {
        width: 12,
        height: 12,
        borderRadius: 6,
    },
    cardInfo: {
        flex: 1,
        minWidth: 0,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
    },
    cardName: {
        fontSize: 14,
        fontWeight: '500',
        color: colors.white,
    },
    mono: {
        fontSize: 11,
        color: colors.gray500,
        fontFamily: 'monospace',
    },
    cardSubtext: {
        fontSize: 12,
        color: colors.gray500,
        marginTop: 2,
    },
    cardMeta: {
        fontSize: 11,
        color: colors.gray600,
        marginTop: 2,
    },
    ownerBadge: {
        fontSize: 10,
        color: colors.gray300,
        backgroundColor: colors.gray700,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    inlineToggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
    },
    actionButtons: {
        flexDirection: 'row',
        gap: 4,
    },
    smallButton: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 6,
        minWidth: 36,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disabledButton: {
        opacity: 0.4,
    },
    disabledControl: {
        opacity: 0.4,
    },
    disabledText: {
        color: colors.gray600,
    },
    smallButtonText: {
        fontSize: 12,
        color: colors.gray400,
    },
    buttonOn: {
        backgroundColor: colors.emerald800_50,
    },
    buttonOnText: {
        color: colors.emerald400,
    },
    buttonOff: {
        backgroundColor: colors.gray700,
    },
    buttonOffText: {
        color: colors.gray400,
    },
    statusSuccess: {
        color: colors.emerald400,
        fontSize: 12,
    },
    statusError: {
        color: colors.red400,
        fontSize: 12,
    },
    statusPending: {
        color: colors.yellow400,
        fontSize: 12,
    },
    deleteText: {
        fontSize: 12,
        color: colors.gray500,
    },
    expandIcon: {
        fontSize: 12,
        color: colors.gray400,
    },
    // Logs
    logsContainer: {
        borderTopWidth: 1,
        borderTopColor: colors.gray700,
        padding: 14,
        maxHeight: 256,
    },
    emptyLogsText: {
        fontSize: 12,
        color: colors.gray500,
    },
    logItem: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 10,
        marginBottom: 6,
    },
    logHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 4,
    },
    logStatusBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    logStatusSuccess: {
        backgroundColor: colors.emerald900_50,
    },
    logStatusError: {
        backgroundColor: colors.red900_50,
    },
    logStatusPending: {
        backgroundColor: colors.yellow900_50,
    },
    logStatusText: {
        fontSize: 11,
    },
    logTime: {
        fontSize: 11,
        color: colors.gray500,
    },
    logResult: {
        fontSize: 11,
        color: colors.gray300,
        fontFamily: 'monospace',
    },
    // Form
    formCard: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
        gap: 10,
    },
    formInput: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        color: colors.gray100,
        fontSize: 14,
    },
    createButton: {
        backgroundColor: colors.blue600,
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: 'center',
    },
    createButtonText: {
        color: colors.white,
        fontSize: 14,
        fontWeight: '500',
    },
    editForm: {
        padding: 14,
        gap: 10,
    },
    cronPreview: {
        fontSize: 12,
        color: colors.blue400,
        marginLeft: 4,
        marginTop: -4,
    },
    nextRunBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: 'rgba(75, 85, 99, 0.4)',
    },
    nextRunBadgeOverdue: {
        backgroundColor: 'rgba(120, 53, 15, 0.4)',
    },
    nextRunBadgeText: {
        fontSize: 10,
        color: colors.gray400,
        fontFamily: 'monospace',
    },
    nextRunBadgeTextOverdue: {
        color: '#fbbf24',
    },
    projectChip: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    projectChipActive: {
        backgroundColor: 'rgba(37, 99, 235, 0.15)',
        borderColor: colors.blue600,
    },
    projectChipText: {
        fontSize: 12,
        color: colors.gray400,
    },
    projectChipTextActive: {
        color: colors.blue400,
        fontWeight: '500',
    },
    primaryBtn: {
        backgroundColor: colors.blue600,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
    },
    primaryBtnText: {
        color: colors.white,
        fontSize: 13,
        fontWeight: '500',
    },
    secondaryBtn: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
    },
    secondaryBtnText: {
        color: colors.gray300,
        fontSize: 13,
    },
    // Agent config
    fieldLabel: {
        fontSize: 12,
        color: colors.gray400,
        marginBottom: 4,
        marginTop: 10,
    },
    notifyToggleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 12,
    },
    notifyCheckbox: {
        width: 18,
        height: 18,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: colors.gray600,
        backgroundColor: colors.gray900,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    notifyCheckboxChecked: {
        backgroundColor: colors.blue500,
        borderColor: colors.blue500,
    },
    notifyCheckboxMark: {
        color: colors.white,
        fontSize: 12,
        lineHeight: 14,
        fontWeight: '700',
    },
    notifyToggleLabel: {
        fontSize: 13,
        color: colors.gray200,
    },
    notifyToggleHint: {
        fontSize: 11,
        color: colors.gray500,
        marginTop: 2,
    },
    engineToggle: {
        flexDirection: 'row',
        gap: 8,
    },
    engineOption: {
        flex: 1,
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingVertical: 8,
        alignItems: 'center',
    },
    engineOptionActive: {
        borderColor: colors.blue600,
        backgroundColor: 'rgba(37, 99, 235, 0.1)',
    },
    engineOptionText: {
        fontSize: 13,
        color: colors.gray400,
    },
    engineOptionTextActive: {
        color: colors.blue400,
    },
    expandedSection: {
        borderTopWidth: 1,
        borderTopColor: colors.gray700,
        padding: 14,
    },
    expandedActions: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 16,
    },
    deleteButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
    },
    deleteButtonText: {
        fontSize: 13,
        color: colors.gray500,
    },
    saveAgentButton: {
        backgroundColor: colors.blue600,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
    },
    saveAgentButtonText: {
        color: colors.white,
        fontSize: 14,
        fontWeight: '500',
    },
    // Slack
    agentIdBadge: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    agentIdText: {
        fontSize: 11,
        color: colors.gray300,
        fontFamily: 'monospace',
    },
    errorText: {
        fontSize: 12,
        color: colors.red400,
        marginTop: 2,
    },
    statusPill: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    statusPillConnected: {
        backgroundColor: colors.emerald800_50,
    },
    statusPillDisconnected: {
        backgroundColor: colors.red900_50,
    },
    statusPillText: {
        fontSize: 11,
    },
    statusPillTextConnected: {
        color: colors.emerald400,
    },
    statusPillTextDisconnected: {
        color: colors.red400,
    },
    messagesSection: {
        marginTop: 20,
    },
    messagesTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.gray400,
        marginBottom: 10,
    },
    slackMessage: {
        backgroundColor: colors.gray800,
        borderRadius: 8,
        padding: 10,
        marginBottom: 6,
    },
    slackUserMsg: {
        fontSize: 12,
        color: colors.blue300,
        marginTop: 4,
    },
    slackBotMsg: {
        fontSize: 12,
        color: colors.gray300,
        marginTop: 2,
    },
    emptyText: {
        fontSize: 14,
        color: colors.gray500,
    },
    accountCard: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        padding: 16,
    },
    accountCardTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.white,
        marginBottom: 8,
    },
    pluginKeyCard: {
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 10,
        padding: 12,
        marginTop: 12,
    },
    pluginKeyHeaderRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    pluginKeyTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.gray200,
        marginBottom: 4,
    },
    accountStatusRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 12,
    },
    accountMutedText: {
        fontSize: 13,
        color: colors.gray500,
    },
    accountStatusText: {
        fontSize: 13,
        fontWeight: '600',
    },
    accountActionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 12,
    },
    accountDangerBtn: {
        backgroundColor: colors.red600,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
    },
    accountDangerBtnText: {
        color: colors.white,
        fontSize: 13,
        fontWeight: '600',
    },
    accountStatusNote: {
        fontSize: 13,
        marginTop: 12,
    },
    // ─── Organizations styles ─────────────────
    sectionDesc: {
        fontSize: 13,
        color: colors.gray500,
        marginBottom: 16,
    },
    orgCard: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        marginBottom: 10,
        overflow: 'hidden',
    },
    orgCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 14,
    },
    orgCardDot: {
        width: 16,
        height: 16,
        borderRadius: 5,
    },
    orgCardName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.white,
    },
    orgCardUrl: {
        fontSize: 11,
        color: colors.gray500,
        marginTop: 1,
    },
    activeBadge: {
        backgroundColor: 'rgba(16, 185, 129, 0.15)',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
    },
    activeBadgeText: {
        fontSize: 11,
        color: colors.emerald400,
        fontWeight: '600',
    },
    switchBtn: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
    },
    switchBtnText: {
        fontSize: 11,
        color: colors.gray300,
        fontWeight: '500',
    },
    expandChevron: {
        color: colors.gray500,
        fontSize: 12,
        marginLeft: 4,
    },
    orgCardExpanded: {
        borderTopWidth: 1,
        borderTopColor: colors.gray700,
        padding: 14,
    },
    orgForm: {},
    inputLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: colors.gray400,
        marginBottom: 6,
    },
    textInput: {
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: colors.white,
    },
    colorRow: {
        flexDirection: 'row',
        gap: 10,
        flexWrap: 'wrap',
    },
    colorBtn: {
        width: 28,
        height: 28,
        borderRadius: 6,
    },
    colorBtnSelected: {
        borderWidth: 2,
        borderColor: colors.white,
    },
    testBtn: {
        marginTop: 12,
        backgroundColor: colors.gray700,
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
    },
    testBtnText: {
        fontSize: 13,
        color: colors.gray300,
        fontWeight: '500',
    },
    testResultText: {
        fontSize: 12,
        marginTop: 8,
    },
    orgCardActions: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 16,
        gap: 10,
    },
    deleteBtn: {
        backgroundColor: colors.red600,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
    },
    deleteBtnText: {
        color: colors.white,
        fontSize: 13,
        fontWeight: '600',
    },
    saveBtn: {
        backgroundColor: colors.blue600,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        flex: 1,
        alignItems: 'center',
    },
    saveBtnText: {
        color: colors.white,
        fontSize: 13,
        fontWeight: '600',
    },
    cancelBtn: {
        backgroundColor: colors.gray700,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
    },
    cancelBtnText: {
        color: colors.gray300,
        fontSize: 13,
        fontWeight: '500',
    },
    newOrgCard: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderStyle: 'dotted',
        borderColor: colors.gray600,
        borderRadius: 12,
        padding: 14,
        marginTop: 6,
    },
    addOrgBtn: {
        borderWidth: 1,
        borderStyle: 'dotted',
        borderColor: colors.gray700,
        borderRadius: 12,
        padding: 14,
        alignItems: 'center',
        marginTop: 6,
    },
    addOrgBtnText: {
        fontSize: 14,
        color: colors.gray500,
        fontWeight: '500',
    },
    // ─── Usage styles ─────────────────────────
    subsectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.gray400,
        marginBottom: 10,
    },
    usageGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 10,
    },
    usageCard: {
        backgroundColor: colors.gray800,
        borderRadius: 10,
        padding: 14,
        flexBasis: '46%',
        flexGrow: 1,
    },
    usageValue: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.white,
    },
    usageLabel: {
        fontSize: 11,
        color: colors.gray500,
        marginTop: 2,
    },
    agentUsageRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    agentUsageDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    agentUsageName: {
        flex: 1,
        fontSize: 13,
        color: colors.gray300,
    },
    agentUsageStat: {
        fontSize: 12,
        color: colors.gray400,
        fontFamily: 'monospace',
        minWidth: 50,
        textAlign: 'right',
    },
    dailyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 4,
    },
    dailyDate: {
        fontSize: 11,
        color: colors.gray500,
        width: 40,
        fontFamily: 'monospace',
    },
    dailyBarContainer: {
        flex: 1,
        height: 14,
        backgroundColor: colors.gray800,
        borderRadius: 3,
        overflow: 'hidden',
        flexDirection: 'row',
    },
    dailyBar: {
        height: 14,
        backgroundColor: 'rgba(16, 185, 129, 0.5)',
        borderRadius: 3,
    },
    dailyCost: {
        fontSize: 11,
        color: colors.emerald400,
        width: 50,
        textAlign: 'right',
        fontFamily: 'monospace',
    },
    recentSessionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    recentSessionName: {
        fontSize: 13,
        color: colors.gray200,
        fontWeight: '500',
    },
    recentSessionAgent: {
        fontSize: 11,
        color: colors.gray500,
        marginTop: 1,
    },
    // ─── Config Backup styles ─────────────────
    backupCard: {
        backgroundColor: colors.gray800,
        borderRadius: 12,
        padding: 16,
    },
    backupCardTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.white,
        marginBottom: 6,
    },
    backupCardDesc: {
        fontSize: 12,
        color: colors.gray500,
        marginBottom: 12,
    },
    previewCard: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 12,
        marginTop: 10,
    },
    previewTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.gray300,
        marginBottom: 8,
    },
    previewLine: {
        fontSize: 12,
        color: colors.gray400,
        marginBottom: 3,
    },
    successBox: {
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        borderWidth: 1,
        borderColor: 'rgba(16, 185, 129, 0.3)',
        borderRadius: 8,
        padding: 12,
        marginTop: 12,
    },
    successText: {
        color: colors.emerald400,
        fontSize: 13,
    },
    errorBox: {
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        borderWidth: 1,
        borderColor: 'rgba(239, 68, 68, 0.3)',
        borderRadius: 8,
        padding: 12,
        marginTop: 12,
    },
    errorBoxText: {
        color: colors.red400,
        fontSize: 13,
    },
});
