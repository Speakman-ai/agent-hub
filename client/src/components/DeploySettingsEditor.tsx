import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api';
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

const inputClass =
  'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-sky-500 focus:outline-none disabled:opacity-60';
const labelClass = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-500';
const smallButton =
  'inline-flex min-h-[28px] items-center gap-1 rounded-md border border-gray-700 px-2 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
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
    <div>
      <span className={labelClass}>Workflow inputs</span>
      <div className="space-y-1.5">
        {inputs.map((row, i) => (
          <div key={i} className="flex items-start gap-1.5" data-testid="workflow-input-row">
            <input
              className={`${inputClass} w-1/3 font-mono text-xs`}
              value={row.key}
              placeholder="name"
              aria-label={`Input ${i + 1} name`}
              disabled={readOnly}
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            {/* textarea, not input: values may contain newlines and must round-trip exactly. */}
            <textarea
              className={`${inputClass} min-h-[34px] flex-1 font-mono text-xs`}
              rows={Math.min(6, Math.max(1, row.value.split('\n').length))}
              value={row.value}
              placeholder="value"
              aria-label={`Input ${i + 1} value`}
              disabled={readOnly}
              onChange={(e) => setRow(i, { value: e.target.value })}
            />
            <button
              type="button"
              className={smallButton}
              disabled={readOnly}
              aria-label={`Remove input ${i + 1}`}
              onClick={() => onChange(inputs.filter((_, j) => j !== i))}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`${smallButton} mt-1.5`}
        disabled={readOnly}
        onClick={() => onChange([...inputs, { key: '', value: '' }])}
      >
        <Plus size={12} />
        Add input
      </button>
    </div>
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
    <div
      className="mt-4 rounded-md border border-gray-800 bg-gray-950/70 p-3"
      data-testid="deploy-settings-preview"
    >
      <label className="flex items-center gap-2 text-sm font-medium text-gray-200">
        <input
          type="checkbox"
          checked={preview.enabled}
          disabled={readOnly}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        PR environments
      </label>
      <p className="mt-1 text-xs text-gray-500">
        Boot the project&apos;s compose stack for each pull request so reviewers can click through
        it. The compose file is read from the PR&apos;s commit.
      </p>
      {preview.enabled ? (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Field label="Compose file">
              <input
                className={inputClass}
                value={preview.compose}
                placeholder="docker-compose.preview.yml"
                disabled={readOnly}
                onChange={(e) => set({ compose: e.target.value })}
              />
            </Field>
            <Field label="Service">
              <input
                className={inputClass}
                value={preview.service}
                placeholder="app"
                disabled={readOnly}
                onChange={(e) => set({ service: e.target.value })}
              />
            </Field>
            <Field label="Port">
              <input
                className={inputClass}
                value={preview.port}
                placeholder="3000"
                inputMode="numeric"
                disabled={readOnly}
                onChange={(e) => set({ port: e.target.value })}
              />
            </Field>
            <Field label="Health path">
              <input
                className={inputClass}
                value={preview.health}
                placeholder="/"
                disabled={readOnly}
                onChange={(e) => set({ health: e.target.value })}
              />
            </Field>
            <Field label="Health timeout (minutes)">
              <input
                className={inputClass}
                value={preview.healthTimeoutMinutes}
                inputMode="numeric"
                disabled={readOnly}
                onChange={(e) => set({ healthTimeoutMinutes: e.target.value })}
              />
            </Field>
            <Field label="Secrets (one name per line)">
              <textarea
                className={`${inputClass} min-h-[34px] font-mono text-xs`}
                value={preview.secrets.join('\n')}
                placeholder="DATABASE_PASSWORD"
                disabled={readOnly}
                onChange={(e) => set({ secrets: e.target.value.split('\n') })}
              />
            </Field>
          </div>
          <div className="mt-3 space-y-2">
            {preview.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2" data-testid="preview-step">
                <input
                  className={`${inputClass} w-1/4`}
                  value={step.name}
                  placeholder={`step ${i + 1}`}
                  aria-label={`Setup step ${i + 1} name`}
                  disabled={readOnly}
                  onChange={(e) => setStep(i, { name: e.target.value })}
                />
                <textarea
                  className={`${inputClass} min-h-[34px] flex-1 font-mono text-xs`}
                  value={step.run}
                  placeholder="docker compose exec -T app npm run db:migrate"
                  aria-label={`Setup step ${i + 1} command`}
                  disabled={readOnly}
                  onChange={(e) => setStep(i, { run: e.target.value })}
                />
                <button
                  type="button"
                  className={smallButton}
                  disabled={readOnly}
                  aria-label={`Remove setup step ${i + 1}`}
                  onClick={() => set({ steps: preview.steps.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={smallButton}
              disabled={readOnly}
              onClick={() => set({ steps: [...preview.steps, { name: '', run: '' }] })}
            >
              <Plus size={12} />
              Add setup step (runs after compose up)
            </button>
          </div>
        </>
      ) : null}
    </div>
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
  return (
    <div className="rounded-md border border-gray-800 bg-gray-900/60 p-3" data-testid="deploy-step">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-400">Step {index + 1}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={smallButton}
            onClick={() => onMove(-1)}
            disabled={readOnly || index === 0}
            aria-label="Move step up"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            className={smallButton}
            onClick={() => onMove(1)}
            disabled={readOnly || index === count - 1}
            aria-label="Move step down"
          >
            <ArrowDown size={12} />
          </button>
          <button
            type="button"
            className={smallButton}
            onClick={onRemove}
            disabled={readOnly}
            aria-label="Remove step"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={step.name}
            placeholder={`step ${index + 1}`}
            disabled={readOnly}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            value={step.kind}
            disabled={readOnly}
            onChange={(e) => set({ kind: e.target.value as DeployStepForm['kind'] })}
          >
            <option value="run">Shell command</option>
            <option value="github_workflow">GitHub Actions workflow</option>
          </select>
        </Field>
      </div>
      {step.kind === 'run' ? (
        <div className="mt-2">
          <Field label="Command (bash -euo pipefail)">
            <textarea
              className={`${inputClass} min-h-[80px] font-mono text-xs`}
              value={step.run}
              placeholder="./scripts/deploy.sh"
              disabled={readOnly}
              onChange={(e) => set({ run: e.target.value })}
            />
          </Field>
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Field label="Workflow file or id">
            <input
              className={inputClass}
              value={step.workflow}
              placeholder="release.yml"
              disabled={readOnly}
              onChange={(e) => set({ workflow: e.target.value })}
            />
          </Field>
          <Field label="Branch or tag">
            <input
              className={inputClass}
              value={step.ref}
              placeholder="main"
              disabled={readOnly}
              onChange={(e) => set({ ref: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <WorkflowInputsEditor
              inputs={step.inputs}
              readOnly={readOnly}
              onChange={(inputs) => set({ inputs })}
            />
          </div>
          <Field label="Poll interval (seconds)">
            <input
              className={inputClass}
              value={step.pollIntervalSeconds}
              placeholder="10"
              inputMode="numeric"
              disabled={readOnly}
              onChange={(e) => set({ pollIntervalSeconds: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
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
  const setStep = (i: number, next: DeployStepForm) =>
    set({ steps: env.steps.map((s, j) => (j === i ? next : s)) });
  const moveStep = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= env.steps.length) return;
    const steps = [...env.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    set({ steps });
  };
  return (
    <div
      className="rounded-md border border-gray-800 bg-gray-950/70 p-3"
      data-testid={`deploy-settings-env-${env.name || 'new'}`}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Environment name">
          <input
            className={inputClass}
            value={env.name}
            placeholder="production"
            disabled={readOnly}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Runner">
          <input
            className={inputClass}
            value={env.runsOn}
            placeholder="ubuntu-24.04 or host"
            disabled={readOnly}
            onChange={(e) => set({ runsOn: e.target.value })}
          />
        </Field>
        <Field label="Timeout (minutes)">
          <input
            className={inputClass}
            value={env.timeoutMinutes}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(e) => set({ timeoutMinutes: e.target.value })}
          />
        </Field>
        <Field label="Origin (optional)">
          <input
            className={inputClass}
            value={env.origin}
            placeholder="https://app.example.com"
            disabled={readOnly}
            onChange={(e) => set({ origin: e.target.value })}
          />
        </Field>
        <Field label="Readiness URL or path (optional)">
          <input
            className={inputClass}
            value={env.readiness}
            placeholder="/health"
            disabled={readOnly}
            onChange={(e) => set({ readiness: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={env.approval}
            disabled={readOnly}
            onChange={(e) => set({ approval: e.target.checked })}
          />
          Require Admin approval
        </label>
      </div>
      <div className="mt-3 space-y-2">
        {env.steps.map((step, i) => (
          <StepEditor
            key={i}
            step={step}
            index={i}
            count={env.steps.length}
            readOnly={readOnly}
            onChange={(next) => setStep(i, next)}
            onMove={(delta) => moveStep(i, delta)}
            onRemove={() => set({ steps: env.steps.filter((_, j) => j !== i) })}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className={smallButton}
          disabled={readOnly}
          onClick={() => set({ steps: [...env.steps, emptyDeployStep()] })}
        >
          <Plus size={12} />
          Add step
        </button>
        <button
          type="button"
          className={`${smallButton} ml-auto`}
          disabled={readOnly}
          onClick={onRemove}
        >
          <Trash2 size={12} />
          Remove environment
        </button>
      </div>
    </div>
  );
}

export default function DeploySettingsEditor({
  projectId,
  canEdit,
  showToast,
  onSaved,
}: {
  projectId?: string | null;
  canEdit: boolean;
  showToast?: (message: string, type?: string) => void;
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
  // Every request records the project it was made for plus a sequence number.
  // A response is applied only if it belongs to the current project and is the
  // newest request, so switching projects can never show or save another
  // project's settings.
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
    // Drop the previous project's state before anything else renders.
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
      showToast?.('Deployment settings saved', 'success');
      onSaved?.();
    } catch (e: any) {
      if (isCurrent(null)) setErrors([e?.message || 'Failed to save deployment settings']);
    } finally {
      if (isCurrent(null)) setSaving(false);
    }
  };

  const revert = async () => {
    if (!loadedProject) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Discard the saved settings and read deploy.yaml again?')
    ) {
      return;
    }
    const isCurrent = beginRequest(loadedProject);
    setSaving(true);
    try {
      const res = (await api.revertDeploySettings(loadedProject)) as DeploySettingsResponse;
      if (!isCurrent(res)) return;
      apply(res);
      showToast?.('Using .agent-hub/deploy.yaml again', 'success');
      onSaved?.();
    } catch (e: any) {
      if (isCurrent(null)) setErrors([e?.message || 'Failed to revert deployment settings']);
    } finally {
      if (isCurrent(null)) setSaving(false);
    }
  };

  const readOnly = !canEdit || saving || !loadedProject;

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/55 p-4"
      data-testid="deploy-settings-editor"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SlidersHorizontal size={16} className="text-sky-400" />
        <h2 className="text-sm font-semibold text-gray-100">Deployment environments</h2>
        {settings ? (
          <span
            className="rounded-md border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300"
            data-testid="deploy-settings-source"
          >
            {deploySettingsSourceLabel(settings.source)}
          </span>
        ) : null}
        {dirty ? <span className="text-[11px] text-amber-300">Unsaved changes</span> : null}
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Steps, approval gates, runners, timeouts, and origins for each environment, plus PR
        environments. Saving here takes effect on the next deploy with no commit; these settings
        then replace <span className="font-mono">.agent-hub/deploy.yaml</span> entirely.
        {canEdit ? null : ' Admin role required to edit.'}
      </p>

      {settings?.repoError ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          <AlertCircle size={13} />
          deploy.yaml could not be read: {settings.repoError}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertCircle size={15} />
          {error}
        </div>
      ) : loading && !settings ? (
        <div className="p-6 text-center text-sm text-gray-500">Loading settings...</div>
      ) : (
        <>
          <div className="space-y-3">
            {envs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-800 p-6 text-center text-sm text-gray-500">
                No environments yet.
              </div>
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
          </div>

          <PreviewEditor preview={preview} readOnly={readOnly} onChange={updatePreview} />

          {errors.length > 0 ? (
            <ul
              className="mt-3 space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300"
              data-testid="deploy-settings-errors"
            >
              {errors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          ) : null}

          {canEdit ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={smallButton}
                disabled={readOnly}
                onClick={() =>
                  update([...envs, emptyDeployEnvironment(envs.length === 0 ? 'production' : '')])
                }
              >
                <Plus size={12} />
                Add environment
              </button>
              {settings?.source === 'settings' ? (
                <button type="button" className={smallButton} disabled={readOnly} onClick={revert}>
                  <RotateCcw size={12} />
                  Use deploy.yaml instead
                </button>
              ) : null}
              <button
                type="button"
                onClick={save}
                disabled={readOnly || (!dirty && settings?.source === 'settings')}
                className="ml-auto inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 text-xs text-sky-100 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
