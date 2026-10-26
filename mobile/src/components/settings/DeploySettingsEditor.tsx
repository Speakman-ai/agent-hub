import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import {
  deployDocumentToForm,
  deployFormToDocument,
  deploySettingsSourceLabel,
  emptyDeployEnvironment,
  emptyDeployPreview,
  emptyDeployStep,
  previewDocumentToForm,
  previewFormToDocument,
  type DeployEnvironmentForm,
  type DeployPreviewForm,
  type DeployWorkflowInputForm,
  type DeploySettingsResponse,
  type DeployStepForm,
} from '@shared/utils/deploySettings';

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  multiline,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  disabled: boolean;
  multiline?: boolean;
  numeric?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.gray600}
        editable={!disabled}
        multiline={multiline}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, multiline && styles.multiline]}
        accessibilityLabel={label}
      />
    </View>
  );
}

function SmallButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.smallButton, disabled && styles.disabled]}
      accessibilityLabel={label}
    >
      {children}
    </TouchableOpacity>
  );
}

function WorkflowInputsEditor({
  inputs,
  readOnly,
  onChange,
}: {
  inputs: DeployWorkflowInputForm[];
  readOnly: boolean;
  onChange: (next: DeployWorkflowInputForm[]) => void;
}) {
  const setRow = (i: number, patch: Partial<DeployWorkflowInputForm>) =>
    onChange(inputs.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <View style={styles.field}>
      <Text style={styles.label}>Workflow inputs</Text>
      {inputs.map((row, i) => (
        <View key={i} style={styles.inputRow} testID="workflow-input-row">
          <TextInput
            value={row.key}
            onChangeText={(key) => setRow(i, { key })}
            placeholder="name"
            placeholderTextColor={colors.gray600}
            editable={!readOnly}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.inputKey]}
            accessibilityLabel={`Input ${i + 1} name`}
          />
          {/* multiline: values may contain newlines and must round-trip exactly. */}
          <TextInput
            value={row.value}
            onChangeText={(value) => setRow(i, { value })}
            placeholder="value"
            placeholderTextColor={colors.gray600}
            editable={!readOnly}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.inputValue]}
            accessibilityLabel={`Input ${i + 1} value`}
          />
          <SmallButton
            label={`Remove input ${i + 1}`}
            onPress={() => onChange(inputs.filter((_, j) => j !== i))}
            disabled={readOnly}
          >
            <Trash2 size={13} color={colors.gray300} />
          </SmallButton>
        </View>
      ))}
      <SmallButton
        label="Add input"
        onPress={() => onChange([...inputs, { key: '', value: '' }])}
        disabled={readOnly}
      >
        <Plus size={13} color={colors.gray300} />
        <Text style={styles.smallText}>Add input</Text>
      </SmallButton>
    </View>
  );
}

function PreviewEditor({
  preview,
  readOnly,
  onChange,
}: {
  preview: DeployPreviewForm;
  readOnly: boolean;
  onChange: (next: DeployPreviewForm) => void;
}) {
  const set = (patch: Partial<DeployPreviewForm>) => onChange({ ...preview, ...patch });
  const setStep = (i: number, patch: Partial<DeployPreviewForm['steps'][number]>) =>
    set({ steps: preview.steps.map((step, j) => (j === i ? { ...step, ...patch } : step)) });
  return (
    <View style={styles.card} testID="deploy-settings-preview">
      <View style={styles.row}>
        <Text style={styles.envTitle}>PR environments</Text>
        <Switch
          value={preview.enabled}
          disabled={readOnly}
          onValueChange={(enabled) => set({ enabled })}
          accessibilityLabel="PR environments"
        />
      </View>
      <Text style={styles.help}>
        Boot the project's compose stack for each pull request. The compose file is read from the
        PR's commit.
      </Text>
      {preview.enabled ? (
        <>
          <Field
            label="Compose file"
            value={preview.compose}
            placeholder="docker-compose.preview.yml"
            disabled={readOnly}
            onChange={(compose) => set({ compose })}
          />
          <Field
            label="Service"
            value={preview.service}
            placeholder="app"
            disabled={readOnly}
            onChange={(service) => set({ service })}
          />
          <Field
            label="Port"
            value={preview.port}
            placeholder="3000"
            numeric
            disabled={readOnly}
            onChange={(port) => set({ port })}
          />
          <Field
            label="Health path"
            value={preview.health}
            placeholder="/"
            disabled={readOnly}
            onChange={(health) => set({ health })}
          />
          <Field
            label="Health timeout (minutes)"
            value={preview.healthTimeoutMinutes}
            numeric
            disabled={readOnly}
            onChange={(healthTimeoutMinutes) => set({ healthTimeoutMinutes })}
          />
          <Field
            label="Secrets (one name per line)"
            value={preview.secrets.join('\n')}
            placeholder="DATABASE_PASSWORD"
            multiline
            disabled={readOnly}
            onChange={(text) => set({ secrets: text.split('\n') })}
          />
          {preview.steps.map((step, i) => (
            <View key={i} style={styles.step} testID="preview-step">
              <Field
                label={`Setup step ${i + 1} name`}
                value={step.name}
                placeholder={`step ${i + 1}`}
                disabled={readOnly}
                onChange={(name) => setStep(i, { name })}
              />
              <Field
                label={`Setup step ${i + 1} command`}
                value={step.run}
                placeholder="docker compose exec -T app npm run db:migrate"
                multiline
                disabled={readOnly}
                onChange={(run) => setStep(i, { run })}
              />
              <SmallButton
                label={`Remove setup step ${i + 1}`}
                onPress={() => set({ steps: preview.steps.filter((_, j) => j !== i) })}
                disabled={readOnly}
              >
                <Trash2 size={13} color={colors.gray300} />
              </SmallButton>
            </View>
          ))}
          <SmallButton
            label="Add setup step"
            onPress={() => set({ steps: [...preview.steps, { name: '', run: '' }] })}
            disabled={readOnly}
          >
            <Plus size={13} color={colors.gray300} />
            <Text style={styles.smallText}>Add setup step</Text>
          </SmallButton>
        </>
      ) : null}
    </View>
  );
}

function StepEditor({
  step,
  index,
  count,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  step: DeployStepForm;
  index: number;
  count: number;
  readOnly: boolean;
  onChange: (next: DeployStepForm) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<DeployStepForm>) => onChange({ ...step, ...patch });
  const isWorkflow = step.kind === 'github_workflow';
  return (
    <View style={styles.step}>
      <View style={styles.row}>
        <Text style={styles.stepTitle}>Step {index + 1}</Text>
        <View style={styles.rowEnd}>
          <SmallButton
            label="Move step up"
            onPress={() => onMove(-1)}
            disabled={readOnly || index === 0}
          >
            <ArrowUp size={13} color={colors.gray300} />
          </SmallButton>
          <SmallButton
            label="Move step down"
            onPress={() => onMove(1)}
            disabled={readOnly || index === count - 1}
          >
            <ArrowDown size={13} color={colors.gray300} />
          </SmallButton>
          <SmallButton label="Remove step" onPress={onRemove} disabled={readOnly}>
            <Trash2 size={13} color={colors.gray300} />
          </SmallButton>
        </View>
      </View>
      <Field
        label="Name"
        value={step.name}
        placeholder={`step ${index + 1}`}
        disabled={readOnly}
        onChange={(name) => set({ name })}
      />
      <View style={styles.row}>
        <Text style={styles.label}>GitHub Actions workflow</Text>
        <Switch
          value={isWorkflow}
          disabled={readOnly}
          onValueChange={(on) => set({ kind: on ? 'github_workflow' : 'run' })}
          accessibilityLabel="GitHub Actions workflow"
        />
      </View>
      {isWorkflow ? (
        <>
          <Field
            label="Workflow file or id"
            value={step.workflow}
            placeholder="release.yml"
            disabled={readOnly}
            onChange={(workflow) => set({ workflow })}
          />
          <Field
            label="Branch or tag"
            value={step.ref}
            placeholder="main"
            disabled={readOnly}
            onChange={(ref) => set({ ref })}
          />
          <WorkflowInputsEditor
            inputs={step.inputs}
            readOnly={readOnly}
            onChange={(inputs) => set({ inputs })}
          />
          <Field
            label="Poll interval (seconds)"
            value={step.pollIntervalSeconds}
            placeholder="10"
            numeric
            disabled={readOnly}
            onChange={(pollIntervalSeconds) => set({ pollIntervalSeconds })}
          />
        </>
      ) : (
        <Field
          label="Command (bash -euo pipefail)"
          value={step.run}
          placeholder="./scripts/deploy.sh"
          multiline
          disabled={readOnly}
          onChange={(run) => set({ run })}
        />
      )}
    </View>
  );
}

function EnvironmentEditor({
  env,
  readOnly,
  onChange,
  onRemove,
}: {
  env: DeployEnvironmentForm;
  readOnly: boolean;
  onChange: (next: DeployEnvironmentForm) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<DeployEnvironmentForm>) => onChange({ ...env, ...patch });
  const moveStep = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= env.steps.length) return;
    const steps = [...env.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    set({ steps });
  };
  return (
    <View style={styles.card} testID={`deploy-settings-env-${env.name || 'new'}`}>
      <Field
        label="Environment name"
        value={env.name}
        placeholder="production"
        disabled={readOnly}
        onChange={(name) => set({ name })}
      />
      <Field
        label="Runner"
        value={env.runsOn}
        placeholder="ubuntu-24.04 or host"
        disabled={readOnly}
        onChange={(runsOn) => set({ runsOn })}
      />
      <Field
        label="Timeout (minutes)"
        value={env.timeoutMinutes}
        numeric
        disabled={readOnly}
        onChange={(timeoutMinutes) => set({ timeoutMinutes })}
      />
      <Field
        label="Origin (optional)"
        value={env.origin}
        placeholder="https://app.example.com"
        disabled={readOnly}
        onChange={(origin) => set({ origin })}
      />
      <Field
        label="Readiness URL or path (optional)"
        value={env.readiness}
        placeholder="/health"
        disabled={readOnly}
        onChange={(readiness) => set({ readiness })}
      />
      <View style={styles.row}>
        <Text style={styles.label}>Require Admin approval</Text>
        <Switch
          value={env.approval}
          disabled={readOnly}
          onValueChange={(approval) => set({ approval })}
          accessibilityLabel="Require Admin approval"
        />
      </View>
      {env.steps.map((step, i) => (
        <StepEditor
          key={i}
          step={step}
          index={i}
          count={env.steps.length}
          readOnly={readOnly}
          onChange={(next) => set({ steps: env.steps.map((s, j) => (j === i ? next : s)) })}
          onMove={(delta) => moveStep(i, delta)}
          onRemove={() => set({ steps: env.steps.filter((_, j) => j !== i) })}
        />
      ))}
      <View style={styles.row}>
        <SmallButton
          label="Add step"
          onPress={() => set({ steps: [...env.steps, emptyDeployStep()] })}
          disabled={readOnly}
        >
          <Plus size={13} color={colors.gray300} />
          <Text style={styles.smallText}>Add step</Text>
        </SmallButton>
        <SmallButton label="Remove environment" onPress={onRemove} disabled={readOnly}>
          <Trash2 size={13} color={colors.gray300} />
          <Text style={styles.smallText}>Remove</Text>
        </SmallButton>
      </View>
    </View>
  );
}

export default function DeploySettingsEditor({
  projectId,
  canEdit,
  onSaved,
}: {
  projectId?: string | null;
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const [settings, setSettings] = useState<DeploySettingsResponse | null>(null);
  const [envs, setEnvs] = useState<DeployEnvironmentForm[]>([]);
  const [preview, setPreview] = useState<DeployPreviewForm>(emptyDeployPreview);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // Responses apply only if they belong to the current project and are the
  // newest request, so a project switch can never show or save stale settings.
  const currentProjectRef = useRef(projectId ?? null);
  const requestSeqRef = useRef(0);
  currentProjectRef.current = projectId ?? null;

  const beginRequest = (forProject: string) => {
    const seq = ++requestSeqRef.current;
    return (res: DeploySettingsResponse | null) => {
      if (seq !== requestSeqRef.current || currentProjectRef.current !== forProject) return false;
      if (res && res.projectId !== forProject) return false;
      return true;
    };
  };

  const apply = (res: DeploySettingsResponse) => {
    setSettings(res);
    setEnvs(deployDocumentToForm(res.environments));
    setPreview(previewDocumentToForm(res.preview));
    setDirty(false);
    setErrors([]);
  };

  const load = useCallback(async () => {
    setSettings(null);
    setEnvs([]);
    setPreview(emptyDeployPreview());
    setDirty(false);
    setErrors([]);
    setError(null);
    if (!projectId) return;
    const isCurrent = beginRequest(projectId);
    setLoading(true);
    try {
      const res = (await api.getDeploySettings(projectId)) as DeploySettingsResponse;
      if (isCurrent(res)) apply(res);
    } catch (e: any) {
      if (isCurrent(null)) setError(e?.message || 'Failed to load deployment settings');
    } finally {
      if (isCurrent(null)) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Writes are allowed only once this project's own settings have loaded.
  const loadedProject =
    settings && projectId && settings.projectId === projectId ? settings.projectId : null;

  const update = (next: DeployEnvironmentForm[]) => {
    setEnvs(next);
    setDirty(true);
  };

  const updatePreview = (next: DeployPreviewForm) => {
    setPreview(next);
    setDirty(true);
  };

  const save = async () => {
    if (!loadedProject) return;
    const envResult = deployFormToDocument(envs);
    const previewResult = previewFormToDocument(preview);
    const problems = [...envResult.errors, ...previewResult.errors];
    setErrors(problems);
    if (problems.length > 0) return;
    const isCurrent = beginRequest(loadedProject);
    setSaving(true);
    try {
      const res = (await api.saveDeploySettings(
        loadedProject,
        envResult.document,
        previewResult.preview,
      )) as DeploySettingsResponse;
      if (!isCurrent(res)) return;
      apply(res);
      onSaved?.();
    } catch (e: any) {
      if (isCurrent(null)) setErrors([e?.message || 'Failed to save deployment settings']);
    } finally {
      if (isCurrent(null)) setSaving(false);
    }
  };

  const doRevert = async () => {
    if (!loadedProject) return;
    const isCurrent = beginRequest(loadedProject);
    setSaving(true);
    try {
      const res = (await api.revertDeploySettings(loadedProject)) as DeploySettingsResponse;
      if (!isCurrent(res)) return;
      apply(res);
      onSaved?.();
    } catch (e: any) {
      if (isCurrent(null)) setErrors([e?.message || 'Failed to revert deployment settings']);
    } finally {
      if (isCurrent(null)) setSaving(false);
    }
  };

  const revert = () =>
    Alert.alert('Use deploy.yaml?', 'Discard the saved settings and read deploy.yaml again?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: doRevert },
    ]);

  const readOnly = !canEdit || saving || !loadedProject;

  return (
    <View style={styles.section} testID="deploy-settings-editor">
      <View style={styles.row}>
        <Text style={styles.title}>Deployment environments</Text>
        {settings ? (
          <Text style={styles.source} testID="deploy-settings-source">
            {deploySettingsSourceLabel(settings.source)}
          </Text>
        ) : null}
      </View>
      <Text style={styles.help}>
        Steps, approval gates, runners, timeouts, and origins for each environment, plus PR
        environments. Saving here takes effect on the next deploy with no commit; these settings
        then replace .agent-hub/deploy.yaml entirely.
        {canEdit ? '' : ' Admin role required to edit.'}
      </Text>
      {dirty ? <Text style={styles.dirty}>Unsaved changes</Text> : null}
      {settings?.repoError ? (
        <Text style={styles.warning}>deploy.yaml could not be read: {settings.repoError}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && !settings ? <ActivityIndicator color={colors.gray400} /> : null}

      {envs.length === 0 && settings && !error ? (
        <Text style={styles.empty}>No environments yet.</Text>
      ) : null}
      {envs.map((env, i) => (
        <EnvironmentEditor
          key={i}
          env={env}
          readOnly={readOnly}
          onChange={(next) => update(envs.map((e, j) => (j === i ? next : e)))}
          onRemove={() => update(envs.filter((_, j) => j !== i))}
        />
      ))}

      {settings ? (
        <PreviewEditor preview={preview} readOnly={readOnly} onChange={updatePreview} />
      ) : null}

      {errors.length > 0 ? (
        <View style={styles.errorBox} testID="deploy-settings-errors">
          {errors.map((msg) => (
            <Text key={msg} style={styles.error}>
              {msg}
            </Text>
          ))}
        </View>
      ) : null}

      {canEdit && loadedProject && settings ? (
        <View style={styles.row}>
          <SmallButton
            label="Add environment"
            onPress={() =>
              update([...envs, emptyDeployEnvironment(envs.length === 0 ? 'production' : '')])
            }
            disabled={readOnly}
          >
            <Plus size={13} color={colors.gray300} />
            <Text style={styles.smallText}>Add environment</Text>
          </SmallButton>
          {settings.source === 'settings' ? (
            <SmallButton label="Use deploy.yaml instead" onPress={revert} disabled={readOnly}>
              <RotateCcw size={13} color={colors.gray300} />
              <Text style={styles.smallText}>Use deploy.yaml</Text>
            </SmallButton>
          ) : null}
          <TouchableOpacity
            onPress={save}
            disabled={readOnly || (!dirty && settings.source === 'settings')}
            style={[
              styles.saveButton,
              (readOnly || (!dirty && settings.source === 'settings')) && styles.disabled,
            ]}
            accessibilityLabel="Save deployment settings"
          >
            {saving ? (
              <ActivityIndicator color={colors.white} size="small" />
            ) : (
              <Save size={13} color={colors.white} />
            )}
            <Text style={styles.saveText}>Save</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowEnd: { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  title: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  source: { color: colors.gray300, fontSize: 11 },
  help: { color: colors.gray500, fontSize: 12, lineHeight: 17 },
  dirty: { color: colors.amber400, fontSize: 12 },
  warning: { color: colors.amber400, fontSize: 12 },
  error: { color: colors.red400, fontSize: 12 },
  errorBox: { gap: 4 },
  empty: { color: colors.gray500, fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray950,
    padding: 10,
    gap: 8,
  },
  step: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    padding: 8,
    gap: 6,
  },
  envTitle: { color: colors.gray200, fontSize: 14, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  inputKey: { flex: 1 },
  inputValue: { flex: 2, minHeight: 34 },
  stepTitle: { color: colors.gray400, fontSize: 12, fontWeight: '500' },
  field: { gap: 4 },
  label: { color: colors.gray500, fontSize: 11, fontWeight: '500' },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray950,
    color: colors.gray200,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top', fontFamily: 'Courier' },
  smallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  smallText: { color: colors.gray300, fontSize: 12 },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    borderRadius: 6,
    backgroundColor: colors.blue500,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  saveText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
