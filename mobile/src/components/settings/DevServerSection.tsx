import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { api } from '../../utils/api';
import { useApp } from '../../context/AppContext';
import { colors } from '../../theme/colors';
import HubIcon from '../HubIcon';
import {
  buildDevServerConfig,
  buildSecretsPutPayload,
  buildSecretsSnapshotPayload,
  devServerFormFromProject,
  emptyDevServerForm,
  validateDevServerForm,
  READY_TIMEOUT_MIN_MS,
  READY_TIMEOUT_MAX_MS,
  type DevServerForm,
  type StoredSecret,
} from '@shared/utils/devServerConfig';

/**
 * Minimal API surface `performDevServerSave` needs — mirrors the three
 * `api.*` calls the web `DevServerSection` uses. Kept narrow so the save
 * orchestration is unit-testable with a fake.
 */
export interface DevServerSaveApi {
  putProjectSecrets: (projectId: string, secrets: unknown) => Promise<any>;
  updateProject: (projectId: string, data: unknown) => Promise<any>;
}

export interface DevServerSaveResult {
  prEnv: Record<string, unknown>;
  mergedSecrets: StoredSecret[];
}

/**
 * Persist the dev-server config with the same guarantees as the web form:
 *
 *  1. Freshly-typed secret values are written FIRST via the full-replace
 *     secrets PUT (unchanged secret rows re-sent as the MASK sentinel so the
 *     store keeps their ciphertext — plaintext is never re-sent). Writing
 *     secrets before the config PATCH means the config never references a
 *     secret the store lacks.
 *  2. The dev-server config is PATCHed onto `project.prEnv.devServer`,
 *     preserving sibling prEnv config.
 *  3. The two writes are not atomic. If the PATCH fails after secrets were
 *     written, we compensate by PUTting the pre-save snapshot (drops the
 *     just-written key, restores prior values via MASK) and re-throw the
 *     original PATCH error.
 *
 * Returns the persisted `prEnv` and the merged stored-secret set so the
 * caller can re-derive the form without a reload (a reload would read the
 * stale pre-save project prop and clobber the just-saved edits).
 */
export async function performDevServerSave(
  saveApi: DevServerSaveApi,
  projectId: string,
  project: any,
  form: DevServerForm,
  existingSecrets: StoredSecret[],
): Promise<DevServerSaveResult> {
  const secretsPayload = buildSecretsPutPayload(form, existingSecrets);
  let secretsWritten = false;
  if (secretsPayload) {
    await saveApi.putProjectSecrets(projectId, secretsPayload);
    secretsWritten = true;
  }

  const devServer = buildDevServerConfig(form);
  const prEnv = { ...(project?.prEnv || {}), devServer };
  try {
    await saveApi.updateProject(projectId, { prEnv });
  } catch (patchErr) {
    if (secretsWritten) {
      try {
        await saveApi.putProjectSecrets(
          projectId,
          buildSecretsSnapshotPayload(existingSecrets) ?? [],
        );
      } catch {
        // Best-effort compensation; surface the original PATCH error.
      }
    }
    throw patchErr;
  }

  const mergedSecrets: StoredSecret[] = secretsPayload
    ? secretsPayload.map((s) => ({ key: s.key, kind: s.kind }))
    : existingSecrets;
  return { prEnv, mergedSecrets };
}

/**
 * Callbacks + staleness guard `loadDevServerSecrets` needs. `isCurrent`
 * returns false once a newer load (a project switch or a Reload tap) has
 * superseded this one, so a slow in-flight response can never apply its
 * result over the newer request's state — which would otherwise pair one
 * project's secrets with another project's config.
 */
export interface DevServerLoadHandlers {
  getProjectSecrets: (projectId: string) => Promise<any>;
  isCurrent: () => boolean;
  onSuccess: (secrets: StoredSecret[]) => void;
  onError: (err: any) => void;
  onSettled: () => void;
}

/**
 * Fetch the (masked) project-secrets snapshot for `projectId`, applying the
 * result ONLY when it is still the current request. Extracted from the
 * component so the stale-response race is unit-testable without rendering RN:
 * every branch first consults `isCurrent()` and no-ops when superseded.
 */
export async function loadDevServerSecrets(
  projectId: string,
  handlers: DevServerLoadHandlers,
): Promise<void> {
  try {
    const res = await handlers.getProjectSecrets(projectId);
    if (!handlers.isCurrent()) return;
    const secrets: StoredSecret[] = Array.isArray(res?.secrets) ? res.secrets : [];
    handlers.onSuccess(secrets);
  } catch (err) {
    if (!handlers.isCurrent()) return;
    handlers.onError(err);
  } finally {
    if (handlers.isCurrent()) handlers.onSettled();
  }
}

/**
 * Per-project dev-server settings section (mobile parity with the web
 * `DevServerSection`). Fields mirror `server/dev-server-config.ts`: start
 * command, working directory, health path, ready timeout, non-secret env,
 * write-only secret references (masked on read), and the internal→proxy
 * port map. Validation mirrors the server Zod schema so bad input surfaces
 * before the PATCH.
 */
export default function DevServerSection({
  project,
  navigation,
}: {
  project?: any;
  navigation?: any;
}) {
  const projectId = project?.id || '';
  const { setActiveAgentId, setActiveSessionId } = useApp();

  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const [form, setForm] = useState<DevServerForm>(() =>
    project ? devServerFormFromProject(project, []) : emptyDevServerForm(),
  );
  const [existingSecrets, setExistingSecrets] = useState<StoredSecret[]>([]);
  // A secrets PUT is a full replace built from this snapshot, so saving
  // against a failed (empty) load would delete every stored project secret
  // not referenced in the form. Saving is blocked until the snapshot loads.
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectRef = useRef(project);
  projectRef.current = project;
  // Monotonic load-request counter. Each load() bumps it; a response only
  // applies when its captured id is still the latest, so a project switch or
  // a Reload tap mid-flight discards the older (now stale) response instead
  // of pairing one project's secrets with another project's config.
  const loadReqRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const reqId = ++loadReqRef.current;
    const isCurrent = () => loadReqRef.current === reqId;
    // Reset the load state for the new request. Clearing `secretsLoaded`
    // re-blocks saving until this project's snapshot lands — critical when
    // the project changed, so a save can't run against the prior project's
    // snapshot.
    setLoading(true);
    setSecretsLoaded(false);
    setError(null);
    await loadDevServerSecrets(projectId, {
      getProjectSecrets: (pid) => api.getProjectSecrets(pid),
      isCurrent,
      onSuccess: (secrets) => {
        setExistingSecrets(secrets);
        setSecretsLoaded(true);
        setForm(devServerFormFromProject(projectRef.current, secrets));
      },
      onError: (err: any) => {
        // Do NOT silently fall back to an empty secret list — a later save
        // would issue a full-replace PUT that wipes stored secrets. Keep the
        // config viewable but block saving until secrets load (Reload).
        setSecretsLoaded(false);
        setExistingSecrets([]);
        setForm(devServerFormFromProject(projectRef.current, []));
        setError(
          `Could not load existing project secrets${
            err?.message ? ` (${err.message})` : ''
          }. Saving is disabled until secrets load — tap Reload to retry.`,
        );
      },
      onSettled: () => setLoading(false),
    });
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (key: keyof DevServerForm, value: any) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // env rows
  const updateEnvRow = (idx: number, patch: any) =>
    setForm((prev) => ({
      ...prev,
      envRows: prev.envRows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  const addEnvRow = () =>
    setForm((prev) => ({ ...prev, envRows: [...prev.envRows, { key: '', value: '' }] }));
  const removeEnvRow = (idx: number) =>
    setForm((prev) => ({ ...prev, envRows: prev.envRows.filter((_, i) => i !== idx) }));

  // secret rows — a `secret`-kind value is stored for this key in the store.
  const keyHasStoredSecret = (key: string) =>
    existingSecrets.some((s) => s.key === key.trim() && s.kind === 'secret');
  const updateSecretRow = (idx: number, patch: any) =>
    setForm((prev) => ({
      ...prev,
      secretRows: prev.secretRows.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch };
        // Recompute `hadSecret` on key change: renaming a stored secret to a
        // key with no stored value must clear the flag, else validation would
        // save a dangling `secretKeys` reference with no backing secret.
        if (Object.prototype.hasOwnProperty.call(patch, 'key')) {
          next.hadSecret = keyHasStoredSecret(next.key);
        }
        return next;
      }),
    }));
  const addSecretRow = () =>
    setForm((prev) => ({
      ...prev,
      secretRows: [...prev.secretRows, { key: '', value: '', hadSecret: false }],
    }));
  const removeSecretRow = (idx: number) =>
    setForm((prev) => ({ ...prev, secretRows: prev.secretRows.filter((_, i) => i !== idx) }));

  // port rows
  const updatePortRow = (idx: number, patch: any) =>
    setForm((prev) => ({
      ...prev,
      portRows: prev.portRows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  const addPortRow = () =>
    setForm((prev) => ({
      ...prev,
      portRows: [...prev.portRows, { internalPort: '', label: '', primary: false }],
    }));
  const removePortRow = (idx: number) =>
    setForm((prev) => ({ ...prev, portRows: prev.portRows.filter((_, i) => i !== idx) }));
  // Only one entry may be primary — selecting one clears the others.
  const setPrimaryPort = (idx: number) =>
    setForm((prev) => ({
      ...prev,
      portRows: prev.portRows.map((r, i) => ({ ...r, primary: i === idx })),
    }));

  const handleSave = async () => {
    if (!project || saving) return;
    if (!secretsLoaded) {
      setError('Project secrets have not loaded — tap Reload before saving.');
      setSaved(false);
      return;
    }
    const validationError = validateDevServerForm(form);
    if (validationError) {
      setError(validationError.error);
      setSaved(false);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { prEnv, mergedSecrets } = await performDevServerSave(
        api as unknown as DevServerSaveApi,
        projectId,
        project,
        form,
        existingSecrets,
      );
      // Re-derive from the payload we just persisted — NOT from a reload that
      // reads `projectRef.current`, which still points at the pre-save prop.
      setExistingSecrets(mergedSecrets);
      setForm(devServerFormFromProject({ prEnv }, mergedSecrets));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err?.message || 'Failed to save dev-server config');
    } finally {
      setSaving(false);
    }
  };

  // Spawn the guided dev-server-setup wizard session and jump into its chat,
  // mirroring the web "Agent walkthrough" button and the mobile Finalize flow.
  const handleStartWalkthrough = useCallback(async () => {
    if (!project || wizardStarting) return;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startDevServerWizard(project.id);
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      if (res.agentId) setActiveAgentId(res.agentId);
      setActiveSessionId(res.sessionId);
      if (navigation && typeof navigation.navigate === 'function') {
        navigation.navigate('Chat');
      }
    } catch (err: any) {
      setWizardError(err?.message || 'Failed to start setup walkthrough');
    } finally {
      setWizardStarting(false);
    }
  }, [project, wizardStarting, navigation, setActiveAgentId, setActiveSessionId]);

  if (!project) {
    return <Text style={styles.emptyText}>No project selected.</Text>;
  }

  return (
    <View>
      <View style={styles.headerRow}>
        <HubIcon name="Terminal" size={18} color={colors.emerald400} />
        <Text style={styles.sectionTitle}>Dev server</Text>
      </View>
      <Text style={styles.sectionDesc}>
        Agent Hub runs your app as a managed long-lived process from the start command inside the
        session env. Non-secret env and referenced secrets are injected at spawn; mapped internal
        ports are exposed through the authenticated preview proxy.
      </Text>

      <TouchableOpacity
        onPress={() => void handleStartWalkthrough()}
        disabled={wizardStarting}
        style={[styles.walkthroughBtn, wizardStarting && styles.primaryBtnDisabled]}
        accessibilityLabel="Start dev-server agent walkthrough"
        testID="dev-server-walkthrough"
      >
        {wizardStarting ? (
          <ActivityIndicator size="small" color={colors.emerald400} />
        ) : (
          <Text style={styles.walkthroughText}>✨ Agent walkthrough</Text>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        Not sure what to fill in? The agent walkthrough opens a guided chat that scans the repo,
        confirms the start command, ports, and env/secret split, and saves the config for you. It
        also checks the app is reachable from a preview browser, which this form can&apos;t do for
        you.
      </Text>
      <Text style={styles.hint}>
        Configuring by hand? The preview browser is not on the machine running your app, so it needs
        to bind 0.0.0.0, allow the proxied Host header, and reach its own API by a relative or
        same-origin URL rather than localhost. A hardcoded loopback API URL is the common one: the
        page loads and every request fails, so the preview looks healthy.
      </Text>
      {wizardError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText} accessibilityLabel="walkthrough error">
            {wizardError}
          </Text>
        </View>
      )}

      <TouchableOpacity
        onPress={() => void load()}
        disabled={loading || saving}
        style={styles.reloadBtn}
        accessibilityLabel="Reload dev-server config"
      >
        <Text style={styles.reloadText}>{loading ? 'Reloading…' : 'Reload'}</Text>
      </TouchableOpacity>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{error}</Text>
        </View>
      )}

      {/* Build command (optional) */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Build command (optional)</Text>
        <TextInput
          value={form.buildCommand}
          onChangeText={(v) => setField('buildCommand', v)}
          placeholder="docker compose build"
          placeholderTextColor={colors.gray500}
          style={styles.monoInput}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="build command"
        />
        <Text style={styles.hint}>
          Runs once before the start command. Restart Server reuses the last build; Rebuild App
          re-runs this first.
        </Text>
      </View>

      {/* Start command */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Start command</Text>
        <TextInput
          value={form.startCommand}
          onChangeText={(v) => setField('startCommand', v)}
          placeholder="npm run dev"
          placeholderTextColor={colors.gray500}
          style={styles.monoInput}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="start command"
        />
        <Text style={styles.hint}>
          Run via sh -c from the working directory (or worktree root). The Hub publishes a
          per-session host port as AGENT_HUB_HOST_PORT — a compose-based server can bind $
          {'${AGENT_HUB_HOST_PORT}'} instead of a hardcoded port so two sessions never collide.
        </Text>
      </View>

      {/* Working directory + health + timeout */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Working directory (optional)</Text>
        <TextInput
          value={form.cwd}
          onChangeText={(v) => setField('cwd', v)}
          placeholder="apps/web"
          placeholderTextColor={colors.gray500}
          style={styles.monoInput}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="working directory"
        />
        <Text style={styles.fieldLabel}>Health path (optional)</Text>
        <TextInput
          value={form.healthPath}
          onChangeText={(v) => setField('healthPath', v)}
          placeholder="/"
          placeholderTextColor={colors.gray500}
          style={styles.monoInput}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="health path"
        />
        <Text style={styles.fieldLabel}>
          Ready timeout (ms, {READY_TIMEOUT_MIN_MS}–{READY_TIMEOUT_MAX_MS})
        </Text>
        <TextInput
          value={form.readyTimeoutMs}
          onChangeText={(v) => setField('readyTimeoutMs', v)}
          placeholder="server default"
          placeholderTextColor={colors.gray500}
          style={styles.input}
          keyboardType="number-pad"
          accessibilityLabel="ready timeout"
        />
      </View>

      {/* System (apt) packages */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>System packages (apt, optional)</Text>
        <TextInput
          value={form.aptPackagesText}
          onChangeText={(v) => setField('aptPackagesText', v)}
          placeholder="imagemagick libmagickwand-dev"
          placeholderTextColor={colors.gray500}
          style={styles.monoInput}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="apt packages"
        />
        <Text style={styles.hint}>
          OS libraries pip/npm can’t install (e.g. ImageMagick for Python Wand). Space- or
          newline-separated. Installed with apt-get before the start command — only on the sysbox
          session backend; skipped with a warning on the host backend.
        </Text>
      </View>

      {/* Pull request previews */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Show previews on all pull requests</Text>
          <Switch
            value={form.previewOnPullRequests}
            onValueChange={(v) => setField('previewOnPullRequests', v)}
            trackColor={{ true: colors.blue500 }}
            accessibilityLabel="Show previews on all pull requests"
          />
        </View>
        <Text style={styles.hint}>
          Surface preview state on every native PR by default. The Enable preview control is always
          available on Hub-hosted PRs when a start command is set; this only auto-opens the section.
        </Text>
      </View>

      {/* Env vars */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Environment variables</Text>
          <TouchableOpacity onPress={addEnvRow} accessibilityLabel="Add env variable">
            <Text style={styles.addText}>Add variable</Text>
          </TouchableOpacity>
        </View>
        {form.envRows.length === 0 && (
          <Text style={styles.emptyText}>No non-secret env variables.</Text>
        )}
        {form.envRows.map((row, idx) => (
          <View key={idx} style={styles.row}>
            <TextInput
              value={row.key}
              onChangeText={(v) => updateEnvRow(idx, { key: v })}
              placeholder="KEY"
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.rowKey]}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="env key"
            />
            <TextInput
              value={row.value}
              onChangeText={(v) => updateEnvRow(idx, { value: v })}
              placeholder="value"
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.rowValue]}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="env value"
            />
            <TouchableOpacity
              onPress={() => removeEnvRow(idx)}
              style={styles.removeBtn}
              accessibilityLabel="Remove env variable"
            >
              <Text style={styles.removeText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Secret references */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Secret references</Text>
          <TouchableOpacity onPress={addSecretRow} accessibilityLabel="Add secret">
            <Text style={styles.addText}>Add secret</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>
          Names of encrypted project secrets injected into the process env at spawn. Values are
          write-only — a stored secret is masked and never returned. Leave the value blank to keep
          the current value.
        </Text>
        {form.secretRows.length === 0 && (
          <Text style={styles.emptyText}>No secret references.</Text>
        )}
        {form.secretRows.map((row, idx) => (
          <View key={idx} style={styles.row}>
            <TextInput
              value={row.key}
              onChangeText={(v) => updateSecretRow(idx, { key: v })}
              placeholder="SECRET_KEY"
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.rowKey]}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="secret key"
            />
            <TextInput
              value={row.value}
              onChangeText={(v) => updateSecretRow(idx, { value: v })}
              placeholder={row.hadSecret ? '•••••••• (stored — blank keeps it)' : 'value'}
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.rowValue]}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel="secret value"
            />
            <Text
              style={[styles.secretStatus, row.hadSecret ? styles.secretSet : styles.secretUnset]}
              accessibilityLabel={row.hadSecret ? 'stored' : 'not stored'}
            >
              {row.hadSecret ? 'set' : '—'}
            </Text>
            <TouchableOpacity
              onPress={() => removeSecretRow(idx)}
              style={styles.removeBtn}
              accessibilityLabel="Remove secret reference"
            >
              <Text style={styles.removeText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Port map */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Port map</Text>
          <TouchableOpacity onPress={addPortRow} accessibilityLabel="Add port">
            <Text style={styles.addText}>Add port</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>
          Internal ports exposed through the authenticated preview proxy. The primary port keeps the
          /preview/proxy/ mount; extra ports get /preview/proxy/p/&lt;port&gt;/.
        </Text>
        {form.portRows.length === 0 && <Text style={styles.emptyText}>No mapped ports.</Text>}
        {form.portRows.map((row, idx) => (
          <View key={idx} style={styles.row}>
            <TextInput
              value={row.internalPort}
              onChangeText={(v) => updatePortRow(idx, { internalPort: v })}
              placeholder="3000"
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.portInput]}
              keyboardType="number-pad"
              accessibilityLabel="internal port"
            />
            <TextInput
              value={row.label}
              onChangeText={(v) => updatePortRow(idx, { label: v })}
              placeholder="web"
              placeholderTextColor={colors.gray500}
              style={[styles.smallInput, styles.rowValue]}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="port label"
            />
            <TouchableOpacity
              onPress={() => setPrimaryPort(idx)}
              style={styles.primaryToggle}
              accessibilityLabel="primary port"
            >
              <Text style={[styles.primaryText, row.primary && styles.primaryTextActive]}>
                {row.primary ? '● primary' : '○ primary'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => removePortRow(idx)}
              style={styles.removeBtn}
              accessibilityLabel="Remove port"
            >
              <Text style={styles.removeText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      <TouchableOpacity
        onPress={handleSave}
        disabled={saving || loading || !secretsLoaded}
        style={[
          styles.primaryBtn,
          (saving || loading || !secretsLoaded) && styles.primaryBtnDisabled,
        ]}
        accessibilityLabel="Save dev-server config"
      >
        {saving ? (
          <ActivityIndicator size="small" color={colors.white} />
        ) : (
          <Text style={styles.primaryBtnText}>Save dev-server config</Text>
        )}
      </TouchableOpacity>
      {saved && <Text style={styles.savedText}>Saved</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  sectionDesc: { fontSize: 12, color: colors.gray500, marginBottom: 12, lineHeight: 17 },
  reloadBtn: { alignSelf: 'flex-start', marginBottom: 12 },
  reloadText: { fontSize: 12, color: colors.gray400, textDecorationLine: 'underline' },
  walkthroughBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.emerald600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  walkthroughText: { fontSize: 13, color: colors.emerald400, fontWeight: '600' },
  card: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.gray200 },
  addText: { fontSize: 12, color: colors.blue400 },
  fieldLabel: { fontSize: 12, color: colors.gray400, marginBottom: 4, marginTop: 8 },
  hint: { fontSize: 11, color: colors.gray500, marginTop: 4, lineHeight: 15 },
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
  monoInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  rowKey: { flex: 4 },
  rowValue: { flex: 6 },
  portInput: { flex: 3 },
  smallInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.gray100,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  removeBtn: { paddingHorizontal: 6, paddingVertical: 6 },
  removeText: { color: colors.gray500, fontSize: 14 },
  secretStatus: { width: 28, textAlign: 'center', fontSize: 10 },
  secretSet: { color: colors.emerald400 },
  secretUnset: { color: colors.gray600 },
  primaryToggle: { paddingHorizontal: 4, paddingVertical: 6 },
  primaryText: { fontSize: 11, color: colors.gray500 },
  primaryTextActive: { color: colors.emerald400, fontWeight: '600' },
  primaryBtn: {
    backgroundColor: colors.emerald600,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: colors.white, fontSize: 14, fontWeight: '600' },
  savedText: { color: colors.emerald400, fontSize: 13, textAlign: 'center', marginTop: 8 },
  emptyText: { fontSize: 12, color: colors.gray600, fontStyle: 'italic', marginTop: 4 },
  errorBox: {
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorBoxText: { color: colors.red400, fontSize: 12, lineHeight: 17 },
});
