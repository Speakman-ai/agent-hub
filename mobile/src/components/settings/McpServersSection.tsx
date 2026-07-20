import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import {
  buildServerConfig,
  emptyMcpServerForm,
  isStdioConfig,
  mcpConfigToForm,
  mcpServerSummary,
  type McpServerForm,
  type McpServerConfigShape,
} from '@shared/utils/mcpServerForm';

/**
 * McpServersSection — native mobile parity for the web `McpServersSection`
 * (client SettingsPage). A collapsible per-agent panel to list, add, edit, and
 * delete MCP servers. All form <-> config translation reuses the shared
 * `@shared/utils/mcpServerForm` engine so the two clients can never drift.
 *
 * Rendered inside each expanded agent card in `AgentsSection`.
 */

/** Shape of the returned `{ mcpServers }` map, keyed by server name. */
export type McpServerMap = Record<string, McpServerConfigShape>;

/**
 * Minimal api surface the mutation helpers need — mirrors the three `api.*`
 * calls used here. Kept narrow so the add/edit/delete orchestration is
 * unit-testable with a fake (the `DevServerSection.performDevServerSave`
 * pattern).
 */
export interface McpServersApi {
  getMcpServers: (agentId: string) => Promise<{ mcpServers?: McpServerMap }>;
  updateMcpServer: (
    agentId: string,
    serverName: string,
    config: McpServerConfigShape,
  ) => Promise<{ mcpServers?: McpServerMap }>;
  deleteMcpServer: (agentId: string, serverName: string) => Promise<{ mcpServers?: McpServerMap }>;
}

/**
 * Upsert one MCP server (add or edit — same PUT). Translates the form to the
 * persisted config via the shared engine, PUTs it, and returns the freshly
 * merged map from the server response. `name` is the (trimmed) server key.
 */
export async function saveMcpServer(
  apiClient: McpServersApi,
  agentId: string,
  name: string,
  form: McpServerForm,
): Promise<McpServerMap> {
  const config = buildServerConfig(form);
  const result = await apiClient.updateMcpServer(agentId, name, config);
  return result.mcpServers || {};
}

/** Delete one MCP server and return the freshly merged map. */
export async function removeMcpServer(
  apiClient: McpServersApi,
  agentId: string,
  name: string,
): Promise<McpServerMap> {
  const result = await apiClient.deleteMcpServer(agentId, name);
  return result.mcpServers || {};
}

type SaveStatus = 'saved' | 'error' | null;

function TypeToggle({ type, onChange }: { type: string; onChange: (t: 'stdio' | 'sse') => void }) {
  return (
    <View style={styles.toggleRow}>
      <TouchableOpacity
        style={[styles.toggleBtn, type === 'stdio' && styles.toggleBtnActive]}
        onPress={() => onChange('stdio')}
      >
        <Text style={[styles.toggleText, type === 'stdio' && styles.toggleTextActive]}>
          stdio (command)
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.toggleBtn, type === 'sse' && styles.toggleBtnActive]}
        onPress={() => onChange('sse')}
      >
        <Text style={[styles.toggleText, type === 'sse' && styles.toggleTextActive]}>SSE (url)</Text>
      </TouchableOpacity>
    </View>
  );
}

function ServerForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  submitLabel,
  saving,
  isEdit,
}: {
  form: McpServerForm;
  setForm: (f: McpServerForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  saving: boolean;
  isEdit: boolean;
}) {
  return (
    <View style={styles.formBox}>
      {!isEdit && (
        <>
          <Text style={styles.fieldLabel}>Server Name</Text>
          <TextInput
            value={form.name}
            onChangeText={(v) => setForm({ ...form, name: v })}
            placeholder="e.g. filesystem, github, slack"
            placeholderTextColor={colors.gray500}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      <Text style={styles.fieldLabel}>Connection Type</Text>
      <TypeToggle type={form.type} onChange={(t) => setForm({ ...form, type: t })} />

      {form.type === 'stdio' ? (
        <>
          <Text style={styles.fieldLabel}>Command</Text>
          <TextInput
            value={form.command}
            onChangeText={(v) => setForm({ ...form, command: v })}
            placeholder="e.g. npx, uvx, node, python"
            placeholderTextColor={colors.gray500}
            style={[styles.input, styles.mono]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.fieldLabel}>Arguments (space-separated or JSON array)</Text>
          <TextInput
            value={form.args}
            onChangeText={(v) => setForm({ ...form, args: v })}
            placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
            placeholderTextColor={colors.gray500}
            style={[styles.input, styles.mono]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      ) : (
        <>
          <Text style={styles.fieldLabel}>URL</Text>
          <TextInput
            value={form.url}
            onChangeText={(v) => setForm({ ...form, url: v })}
            placeholder="e.g. http://localhost:8080/sse"
            placeholderTextColor={colors.gray500}
            style={[styles.input, styles.mono]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      <Text style={styles.fieldLabel}>Environment Variables (KEY=VALUE per line or JSON)</Text>
      <TextInput
        value={form.env}
        onChangeText={(v) => setForm({ ...form, env: v })}
        placeholder={'API_KEY=sk-xxx\nANOTHER_VAR=value'}
        placeholderTextColor={colors.gray500}
        style={[styles.input, styles.mono, { minHeight: 60 }]}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>Working Directory (optional)</Text>
      <TextInput
        value={form.cwd}
        onChangeText={(v) => setForm({ ...form, cwd: v })}
        placeholder="/path/to/working/directory"
        placeholderTextColor={colors.gray500}
        style={[styles.input, styles.mono]}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.formActions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
          onPress={onSubmit}
          disabled={saving}
        >
          <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : submitLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * A single saved-server list row (non-editing). Presentational — all state and
 * callbacks are owned by the parent — so it static-renders in tests.
 */
export function McpServerRow({
  name,
  config,
  confirmingDelete,
  onEdit,
  onDelete,
}: {
  name: string;
  config: McpServerConfigShape;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stdio = isStdioConfig(config);
  const envKeys = config.env ? Object.keys(config.env) : [];
  return (
    <View style={styles.serverRow}>
      <View style={styles.serverInfo}>
        <View style={styles.serverTitleRow}>
          <Text style={styles.serverName}>{name}</Text>
          <Text style={styles.serverType}>{stdio ? 'stdio' : 'sse'}</Text>
        </View>
        <Text style={styles.serverSummary} numberOfLines={1}>
          {mcpServerSummary(config)}
        </Text>
        {envKeys.length > 0 && <Text style={styles.serverEnv}>env: {envKeys.join(', ')}</Text>}
      </View>
      <View style={styles.serverActions}>
        <TouchableOpacity onPress={onEdit} style={styles.iconBtn}>
          <Text style={styles.editText}>Edit</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDelete} style={styles.iconBtn}>
          <Text style={[styles.rowDeleteText, confirmingDelete && styles.rowDeleteTextActive]}>
            {confirmingDelete ? 'Confirm' : 'Delete'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function McpServersSection({ agentId }: { agentId: string }) {
  const [servers, setServers] = useState<Record<string, McpServerConfigShape>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<McpServerForm>(emptyMcpServerForm());
  const [newServer, setNewServer] = useState<McpServerForm>(emptyMcpServerForm());
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadServers = useCallback(() => {
    setLoading(true);
    api
      .getMcpServers(agentId)
      .then((data: any) => setServers(data.mcpServers || {}))
      .catch((err: any) => console.error('Failed to load MCP servers:', err))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const flashStatus = (status: Exclude<SaveStatus, null>) => {
    setSaveStatus(status);
    setTimeout(() => setSaveStatus(null), status === 'saved' ? 2000 : 3000);
  };

  const handleAddServer = async () => {
    if (!newServer.name.trim()) return;
    setSaving(true);
    try {
      const map = await saveMcpServer(api, agentId, newServer.name.trim(), newServer);
      setServers(map);
      setShowAdd(false);
      setNewServer(emptyMcpServerForm());
      flashStatus('saved');
    } catch (err: any) {
      console.error('Failed to add MCP server:', err);
      flashStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateServer = async (name: string) => {
    setSaving(true);
    try {
      const map = await saveMcpServer(api, agentId, name, editForm);
      setServers(map);
      setEditingServer(null);
      flashStatus('saved');
    } catch (err: any) {
      console.error('Failed to update MCP server:', err);
      flashStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteServer = async (name: string) => {
    try {
      const map = await removeMcpServer(api, agentId, name);
      setServers(map);
      setConfirmDelete(null);
      setEditingServer(null);
    } catch (err: any) {
      console.error('Failed to delete MCP server:', err);
    }
  };

  const startEdit = (name: string, config: McpServerConfigShape) => {
    setEditForm(mcpConfigToForm(name, config));
    setEditingServer(name);
    setShowAdd(false);
  };

  const requestDelete = (name: string) => {
    if (confirmDelete === name) {
      handleDeleteServer(name);
    } else {
      setConfirmDelete(name);
      setTimeout(() => setConfirmDelete((cur) => (cur === name ? null : cur)), 3000);
    }
  };

  const serverEntries = Object.entries(servers);
  const serverCount = serverEntries.length;

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity style={styles.header} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.headerLabel}>MCP Servers</Text>
        {serverCount > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{serverCount}</Text>
          </View>
        )}
        {saveStatus === 'saved' && <Text style={styles.savedText}>Saved</Text>}
        {saveStatus === 'error' && <Text style={styles.errorText}>Error</Text>}
        <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.body}>
          {loading && <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 12 }} />}

          {!loading && serverCount === 0 && !showAdd && (
            <Text style={styles.emptyText}>
              No MCP servers configured. Add servers to give this agent access to external tools.
            </Text>
          )}

          {serverEntries.map(([name, config]) => {
            if (editingServer === name) {
              return (
                <View key={name} style={styles.editWrap}>
                  <View style={styles.editHeader}>
                    <Text style={styles.editingLabel}>Editing: {name}</Text>
                    <TouchableOpacity
                      style={[styles.deleteChip, confirmDelete === name && styles.deleteChipActive]}
                      onPress={() => requestDelete(name)}
                    >
                      <Text
                        style={[
                          styles.deleteChipText,
                          confirmDelete === name && styles.deleteChipTextActive,
                        ]}
                      >
                        {confirmDelete === name ? 'Confirm Delete' : 'Delete'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <ServerForm
                    form={editForm}
                    setForm={setEditForm}
                    onSubmit={() => handleUpdateServer(name)}
                    onCancel={() => setEditingServer(null)}
                    submitLabel="Save Changes"
                    saving={saving}
                    isEdit
                  />
                </View>
              );
            }

            return (
              <McpServerRow
                key={name}
                name={name}
                config={config}
                confirmingDelete={confirmDelete === name}
                onEdit={() => startEdit(name, config)}
                onDelete={() => requestDelete(name)}
              />
            );
          })}

          {showAdd ? (
            <ServerForm
              form={newServer}
              setForm={setNewServer}
              onSubmit={handleAddServer}
              onCancel={() => {
                setShowAdd(false);
                setNewServer(emptyMcpServerForm());
              }}
              submitLabel="Add Server"
              saving={saving}
              isEdit={false}
            />
          ) : (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => {
                setShowAdd(true);
                setEditingServer(null);
              }}
            >
              <Text style={styles.addBtnText}>+ Add MCP Server</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    marginTop: 12,
    paddingTop: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerLabel: {
    fontSize: 12,
    color: colors.gray400,
    fontWeight: '500',
  },
  countBadge: {
    backgroundColor: 'rgba(30, 58, 138, 0.5)',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  countBadgeText: {
    fontSize: 11,
    color: colors.blue400,
  },
  savedText: {
    fontSize: 11,
    color: colors.emerald400,
  },
  errorText: {
    fontSize: 11,
    color: colors.red400,
  },
  expandIcon: {
    fontSize: 11,
    color: colors.gray500,
    marginLeft: 'auto',
  },
  body: {
    marginTop: 10,
    gap: 8,
  },
  emptyText: {
    fontSize: 12,
    color: colors.gray500,
  },
  serverRow: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  serverInfo: {
    flex: 1,
    minWidth: 0,
  },
  serverTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serverName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray200,
  },
  serverType: {
    fontSize: 11,
    color: colors.gray500,
  },
  serverSummary: {
    fontSize: 11,
    color: colors.gray500,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  serverEnv: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
  },
  serverActions: {
    flexDirection: 'row',
    gap: 12,
  },
  iconBtn: {
    paddingVertical: 4,
  },
  editText: {
    fontSize: 12,
    color: colors.blue400,
  },
  rowDeleteText: {
    fontSize: 12,
    color: colors.gray500,
  },
  rowDeleteTextActive: {
    color: colors.red400,
    fontWeight: '600',
  },
  editWrap: {
    marginBottom: 4,
  },
  editHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  editingLabel: {
    fontSize: 12,
    color: colors.gray400,
    fontWeight: '500',
  },
  deleteChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  deleteChipActive: {
    backgroundColor: colors.red900_50,
  },
  deleteChipText: {
    fontSize: 11,
    color: colors.gray500,
  },
  deleteChipTextActive: {
    color: colors.red400,
    fontWeight: '600',
  },
  formBox: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
  },
  fieldLabel: {
    fontSize: 11,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 10,
  },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  toggleBtnActive: {
    backgroundColor: colors.blue600,
  },
  toggleText: {
    fontSize: 12,
    color: colors.gray400,
  },
  toggleTextActive: {
    color: colors.white,
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cancelBtnText: {
    fontSize: 12,
    color: colors.gray400,
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
  addBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  addBtnText: {
    fontSize: 12,
    color: colors.blue400,
  },
});
