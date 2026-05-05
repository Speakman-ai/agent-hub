import { useState, useMemo, useEffect, useRef } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Server,
  FileCode,
  CheckCircle2,
  AlertCircle,
  Copy,
  Download,
  Loader2,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Sparkles,
  PlayCircle,
} from 'lucide-react';
import { api } from '../utils/api.js';
import {
  formFromConfig,
  validateForm,
  generateDefaultDockerfile,
  PR_ENV_PREVIEW_IDLE_TTL_PRESETS,
} from '../utils/prEnvProjectPayload.js';

/**
 * Per-project PR-env Settings wizard. Three steps:
 *
 *   1. Enable / explain — toggle the feature on for this project.
 *   2. Start command + port + (optional) setup + health path.
 *   3. Optional Dockerfile path; "Generate one for me" button writes a
 *      sane node:20-slim template into a textarea the user can copy or
 *      download.
 *
 * Save target: `PATCH /api/projects/:id { prEnv: { ... } }`. The
 * payload is built by `validateForm` so empty optional fields are
 * stripped before they hit the server. On success we call
 * `onSaved(updatedProject)` so the parent can refresh its project
 * list.
 */
export default function PrEnvProjectWizard({
  project,
  onClose,
  onSaved,
  showToast,
  // Optional deep-link hint. When `'preview'`, we open the wizard at
  // step 2 (Runtime) and scroll/highlight the preview sub-section so
  // users following the teach-moment from chat land on the right
  // control without having to hunt.
  focus = null,
}) {
  const initialForm = useMemo(() => {
    const form = formFromConfig(project?.prEnv);
    const previewBase = form.preview || {
      enabled: false,
      startScript: '',
      port: '',
      captureRoutes: [{ value: '/' }],
      idleTTL: '600',
    };
    const captureRoutes = (
      Array.isArray(previewBase.captureRoutes) && previewBase.captureRoutes.length > 0
        ? previewBase.captureRoutes
        : [{ value: '/' }]
    ).map((row) => ({ _id: crypto.randomUUID(), ...row }));
    return {
      ...form,
      envRows: form.envRows.map((row) => ({ _id: crypto.randomUUID(), ...row })),
      preview: { ...previewBase, captureRoutes },
    };
  }, [project]);
  // Honour the deep-link from the preview teach-moment in chat: jump
  // straight to step 2 (Runtime, where the preview sub-section lives).
  // Only the initial render reads `focus` — subsequent navigation uses
  // the regular step buttons so we don't fight user intent.
  const [step, setStep] = useState(focus === 'preview' ? 1 : 0);
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [dockerfilePreview, setDockerfilePreview] = useState('');
  const [copied, setCopied] = useState(false);
  // Test-boot affordance state (button on the preview sub-section).
  // The endpoint is implemented server-side as
  // `POST /api/projects/:id/preview/test-boot` — we render the
  // returned screenshot inline so the user can confirm the runtime
  // boots before they save. Failures surface as a small error blurb
  // under the button rather than tearing down the wizard.
  const [testBoot, setTestBoot] = useState({
    status: 'idle', // 'idle' | 'running' | 'ok' | 'error'
    screenshotUrl: null,
    logsTail: null,
    error: null,
  });
  // Ref to the preview sub-section so we can scroll/highlight it when
  // the wizard is opened with `focus="preview"`.
  const previewSectionRef = useRef(null);

  // Reset preview when the user changes inputs that feed into it.
  useEffect(() => {
    setDockerfilePreview('');
  }, [form.setupCommand, form.startScript, form.internalPort]);

  // Scroll/highlight the preview sub-section when the wizard is opened
  // via the `?focus=preview` deep-link from the chat teach-moment. The
  // ref is null until step 2 mounts, so the effect is a no-op on step 0.
  // Declared before the early return so React sees the same hook order
  // on every render (rules-of-hooks).
  useEffect(() => {
    if (focus !== 'preview' || step !== 1) return;
    if (!previewSectionRef.current) return;
    previewSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, step]);

  if (!project) return null;

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
    setSaveError(null);
  };

  // Env-row mutators. We clear *all* env-row errors on any change since
  // adding/removing a row shifts the index keys (`env.0.key`, ...) and
  // re-validating happens on Next/Save anyway.
  const clearEnvErrors = () => {
    setErrors((prev) => {
      const next = {};
      for (const k of Object.keys(prev)) {
        if (!k.startsWith('env')) next[k] = prev[k];
      }
      return next;
    });
  };
  const updateEnvRow = (index, patch) => {
    setForm((prev) => {
      const rows = Array.isArray(prev.envRows) ? prev.envRows.slice() : [];
      rows[index] = { ...(rows[index] || { key: '', value: '' }), ...patch };
      return { ...prev, envRows: rows };
    });
    clearEnvErrors();
    setSaveError(null);
  };
  const addEnvRow = () => {
    setForm((prev) => {
      const rows = Array.isArray(prev.envRows) ? prev.envRows.slice() : [];
      rows.push({ _id: crypto.randomUUID(), key: '', value: '' });
      return { ...prev, envRows: rows };
    });
    clearEnvErrors();
    setSaveError(null);
  };
  const removeEnvRow = (index) => {
    setForm((prev) => {
      const rows = Array.isArray(prev.envRows) ? prev.envRows.slice() : [];
      rows.splice(index, 1);
      return { ...prev, envRows: rows };
    });
    clearEnvErrors();
    setSaveError(null);
  };

  // Preview sub-form mutators. Mirror the env-row pattern — every
  // mutator clears `saveError` and any preview-keyed validation errors
  // since indices shift on row add/remove.
  const clearPreviewErrors = () => {
    setErrors((prev) => {
      const next = {};
      for (const k of Object.keys(prev)) {
        if (!k.startsWith('preview')) next[k] = prev[k];
      }
      return next;
    });
  };
  const setPreviewField = (key, value) => {
    setForm((prev) => ({
      ...prev,
      preview: { ...(prev.preview || {}), [key]: value },
    }));
    if (errors[`preview.${key}`]) {
      setErrors((prev) => ({ ...prev, [`preview.${key}`]: undefined }));
    }
    setSaveError(null);
  };
  const updateRouteRow = (index, value) => {
    setForm((prev) => {
      const rows = Array.isArray(prev.preview?.captureRoutes)
        ? prev.preview.captureRoutes.slice()
        : [];
      rows[index] = { ...(rows[index] || { _id: crypto.randomUUID() }), value };
      return { ...prev, preview: { ...prev.preview, captureRoutes: rows } };
    });
    clearPreviewErrors();
    setSaveError(null);
  };
  const addRouteRow = () => {
    setForm((prev) => {
      const rows = Array.isArray(prev.preview?.captureRoutes)
        ? prev.preview.captureRoutes.slice()
        : [];
      rows.push({ _id: crypto.randomUUID(), value: '' });
      return { ...prev, preview: { ...prev.preview, captureRoutes: rows } };
    });
    clearPreviewErrors();
    setSaveError(null);
  };
  const removeRouteRow = (index) => {
    setForm((prev) => {
      const rows = Array.isArray(prev.preview?.captureRoutes)
        ? prev.preview.captureRoutes.slice()
        : [];
      rows.splice(index, 1);
      return {
        ...prev,
        preview: {
          ...prev.preview,
          captureRoutes: rows.length > 0 ? rows : [{ _id: crypto.randomUUID(), value: '' }],
        },
      };
    });
    clearPreviewErrors();
    setSaveError(null);
  };

  const goNext = () => {
    if (step === 1) {
      // Validate step 2 inputs before letting the user move on.
      const result = validateForm(form);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 2));
  };
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const handleGenerateDockerfile = () => {
    const portNum = Number(form.internalPort);
    setDockerfilePreview(
      generateDefaultDockerfile({
        setupCommand: form.setupCommand,
        startScript: form.startScript,
        internalPort: Number.isFinite(portNum) ? portNum : undefined,
      }),
    );
  };

  const handleCopyDockerfile = async () => {
    if (!dockerfilePreview) return;
    try {
      await navigator.clipboard.writeText(dockerfilePreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  const handleDownloadDockerfile = () => {
    if (!dockerfilePreview) return;
    const blob = new Blob([dockerfilePreview], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Dockerfile';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Trigger a 30-second preview boot via the test-boot endpoint and
   * surface the returned screenshot inline. This is a "did I configure
   * it right?" sanity check before save — any failure renders the log
   * tail so the user can debug without leaving the wizard.
   */
  const handleTestBoot = async () => {
    setTestBoot({ status: 'running', screenshotUrl: null, logsTail: null, error: null });
    try {
      const result = await api.testBootPreview(project.id);
      const ok = (result?.status || 'error') === 'ok';
      setTestBoot({
        status: ok ? 'ok' : 'error',
        screenshotUrl: result?.screenshotUrl || null,
        logsTail: Array.isArray(result?.logsTail) ? result.logsTail : null,
        error: ok ? null : result?.error || 'Preview boot did not reach ready',
      });
    } catch (err) {
      setTestBoot({
        status: 'error',
        screenshotUrl: null,
        logsTail: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSave = async () => {
    const result = validateForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      // Step back to the input step so the user can see the errors.
      if (step === 2) setStep(1);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateProject(project.id, { prEnv: result.payload });
      if (typeof onSaved === 'function') onSaved(updated);
      if (typeof showToast === 'function') {
        showToast({ kind: 'success', text: 'PR-env settings saved' });
      }
      onClose?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';
  const errorClass = 'text-xs text-red-400 mt-1 flex items-center gap-1';

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Configure PR Preview Environment"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <GitBranch size={20} className="text-emerald-400" />
            PR Preview Environment — {project.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 px-4 pt-4">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors ${
                  idx === step
                    ? 'bg-emerald-600 border-emerald-500 text-white'
                    : idx < step
                      ? 'bg-emerald-900/50 border-emerald-700 text-emerald-300'
                      : 'bg-gray-800 border-gray-700 text-gray-500'
                }`}
              >
                {idx < step ? <CheckCircle2 size={14} /> : idx + 1}
              </div>
              {idx < 2 && (
                <div className={`w-8 h-0.5 ${idx < step ? 'bg-emerald-700' : 'bg-gray-700'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {step === 0 && <Step0Enable form={form} setField={setField} />}
          {step === 1 && (
            <Step1Runtime
              form={form}
              setField={setField}
              errors={errors}
              inputClass={inputClass}
              labelClass={labelClass}
              errorClass={errorClass}
              onEnvRowChange={updateEnvRow}
              onEnvRowAdd={addEnvRow}
              onEnvRowRemove={removeEnvRow}
              setPreviewField={setPreviewField}
              onRouteChange={updateRouteRow}
              onRouteAdd={addRouteRow}
              onRouteRemove={removeRouteRow}
              previewSectionRef={previewSectionRef}
              focusPreview={focus === 'preview'}
              testBoot={testBoot}
              onTestBoot={handleTestBoot}
            />
          )}
          {step === 2 && (
            <Step2Dockerfile
              form={form}
              setField={setField}
              inputClass={inputClass}
              labelClass={labelClass}
              dockerfilePreview={dockerfilePreview}
              copied={copied}
              onGenerate={handleGenerateDockerfile}
              onCopy={handleCopyDockerfile}
              onDownload={handleDownloadDockerfile}
            />
          )}
        </div>

        {saveError && (
          <div className="px-5 pb-2">
            <p className="text-xs text-red-400 flex items-center gap-1">
              <AlertCircle size={14} />
              {saveError}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-t border-gray-700">
          <button
            type="button"
            onClick={step === 0 ? onClose : goBack}
            className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-800 flex items-center gap-1"
            disabled={saving}
          >
            <ChevronLeft size={14} />
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < 2 ? (
            <button
              type="button"
              onClick={goNext}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={saving}
            >
              Next
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step0Enable({ form, setField }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Server size={18} className="text-emerald-400 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-gray-100 mb-1">
            Auto-build a preview environment for every PR
          </h4>
          <p className="text-xs text-gray-400 leading-relaxed">
            When enabled, Agent Hub clones the PR&apos;s ref into a per-project workspace, runs your
            start script inside a container, and posts a sticky preview URL on the PR. Synchronized
            pushes rebuild the same checkout. Capped at 10 simultaneous builds per project.
          </p>
        </div>
      </div>

      <label className="flex items-center justify-between bg-gray-800/60 border border-gray-700 rounded-lg p-3 cursor-pointer">
        <div>
          <div className="text-sm font-medium text-gray-100">PR Preview Environments</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {form.enabled
              ? 'Enabled — preview env builds on every PR.'
              : 'Disabled — no preview envs are built.'}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          onClick={() => setField('enabled', !form.enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            form.enabled ? 'bg-emerald-500' : 'bg-gray-600'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              form.enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </label>

      {!form.enabled && (
        <p className="text-xs text-gray-500 italic">
          Toggle on to continue. You can come back and disable any time.
        </p>
      )}
    </div>
  );
}

function Step1Runtime({
  form,
  setField,
  errors,
  inputClass,
  labelClass,
  errorClass,
  onEnvRowChange,
  onEnvRowAdd,
  onEnvRowRemove,
  setPreviewField,
  onRouteChange,
  onRouteAdd,
  onRouteRemove,
  previewSectionRef,
  focusPreview,
  testBoot,
  onTestBoot,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Server size={18} className="text-emerald-400 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-gray-100 mb-1">How does your app start?</h4>
          <p className="text-xs text-gray-400 leading-relaxed">
            Agent Hub will run these commands inside the container after cloning the PR. Your app
            must bind to <span className="font-mono text-gray-300">0.0.0.0</span> so nginx can reach
            it.
          </p>
        </div>
      </div>

      <div>
        <label className={labelClass}>Start command / script location *</label>
        <input
          type="text"
          value={form.startScript}
          onChange={(e) => setField('startScript', e.target.value)}
          placeholder="npm start, ./scripts/pr-env.sh, node server.js, ..."
          className={inputClass}
        />
        <p className="text-[11px] text-gray-500 mt-1">
          A shell command run from the repo root, or a path to a script in the repo (e.g.{' '}
          <span className="font-mono text-gray-300">./scripts/pr-env.sh</span>). Runs after the
          optional setup command.
        </p>
        {errors.startScript && (
          <p className={errorClass}>
            <AlertCircle size={12} />
            {errors.startScript}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Internal port *</label>
        <input
          type="number"
          value={form.internalPort}
          onChange={(e) => setField('internalPort', e.target.value)}
          placeholder="3000"
          min="1"
          max="65535"
          className={inputClass}
        />
        {errors.internalPort && (
          <p className={errorClass}>
            <AlertCircle size={12} />
            {errors.internalPort}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass}>Setup command (optional)</label>
        <input
          type="text"
          value={form.setupCommand}
          onChange={(e) => setField('setupCommand', e.target.value)}
          placeholder="npm install, pnpm install --frozen-lockfile, ..."
          className={inputClass}
        />
        <p className="text-[11px] text-gray-500 mt-1">
          Run once after clone, before the start command.
        </p>
      </div>

      <div>
        <label className={labelClass}>Health path (optional)</label>
        <input
          type="text"
          value={form.healthPath}
          onChange={(e) => setField('healthPath', e.target.value)}
          placeholder="/healthz (defaults to /)"
          className={inputClass}
        />
        {errors.healthPath && (
          <p className={errorClass}>
            <AlertCircle size={12} />
            {errors.healthPath}
          </p>
        )}
      </div>

      <EnvVarsEditor
        rows={Array.isArray(form.envRows) ? form.envRows : []}
        errors={errors}
        labelClass={labelClass}
        errorClass={errorClass}
        onChange={onEnvRowChange}
        onAdd={onEnvRowAdd}
        onRemove={onEnvRowRemove}
      />

      <PreviewSubSection
        sectionRef={previewSectionRef}
        focusPreview={focusPreview}
        preview={form.preview || {}}
        startScriptFallback={form.startScript}
        portFallback={form.internalPort}
        errors={errors}
        inputClass={inputClass}
        labelClass={labelClass}
        errorClass={errorClass}
        setPreviewField={setPreviewField}
        onRouteChange={onRouteChange}
        onRouteAdd={onRouteAdd}
        onRouteRemove={onRouteRemove}
        testBoot={testBoot}
        onTestBoot={onTestBoot}
      />
    </div>
  );
}

/**
 * "Live previews during chat" sub-section. Sits at the bottom of the
 * Runtime step so users discover it after they've already configured
 * the rest of the runtime — preview defaults to *off* and falls back
 * to the parent runtime's start command + port when a field is left
 * blank, so an enabled-but-empty preview block is still a sensible
 * configuration.
 *
 * The whole section dims to 60% opacity and disables every input when
 * `enabled === false` so the toggle is visually authoritative — there
 * are too many sub-fields to leave them looking interactive when they
 * have no effect.
 */
function PreviewSubSection({
  sectionRef,
  focusPreview,
  preview,
  startScriptFallback,
  portFallback,
  errors,
  inputClass,
  labelClass,
  errorClass,
  setPreviewField,
  onRouteChange,
  onRouteAdd,
  onRouteRemove,
  testBoot,
  onTestBoot,
}) {
  const enabled = !!preview.enabled;
  const captureRoutes = Array.isArray(preview.captureRoutes) ? preview.captureRoutes : [];
  const startPlaceholder = `falls back to ${(startScriptFallback || '').trim() || '$startScript'}`;
  const portPlaceholder = `falls back to ${(portFallback || '').trim() || '$internalPort'}`;
  const ttlValue = String(preview.idleTTL ?? '');
  return (
    <div
      ref={sectionRef}
      className={`border-t border-gray-800 pt-4 space-y-3 transition-colors ${
        focusPreview ? 'ring-1 ring-emerald-500/40 rounded-lg p-3 -m-3' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="text-emerald-400 mt-0.5" />
          <div>
            <h5 className="text-sm font-medium text-gray-100">Live previews during chat</h5>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              When an agent emits an{' '}
              <span className="font-mono text-gray-300">&lt;agenthub:preview&gt;</span> block, Agent
              Hub spins up a per-session worktree preview, screenshots the requested routes, and
              renders the result inline. Idle previews are reaped automatically.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Enable live previews during chat"
          onClick={() => setPreviewField('enabled', !enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            enabled ? 'bg-emerald-500' : 'bg-gray-600'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {!enabled && (
        <p className="text-[11px] text-gray-600 italic">
          Toggle on to configure preview-specific start command, port, capture routes, and idle TTL.
        </p>
      )}

      <div
        className={`space-y-3 ${enabled ? '' : 'opacity-60 pointer-events-none select-none'}`}
        aria-disabled={!enabled}
      >
        <div>
          <label className={labelClass}>Preview start command (optional)</label>
          <input
            type="text"
            value={preview.startScript || ''}
            onChange={(e) => setPreviewField('startScript', e.target.value)}
            placeholder={startPlaceholder}
            className={inputClass}
            disabled={!enabled}
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Use a different command for the chat preview (e.g.{' '}
            <span className="font-mono">npm run dev</span>). Falls back to the runtime start command
            when empty.
          </p>
        </div>

        <div>
          <label className={labelClass}>Preview port (optional)</label>
          <input
            type="number"
            value={preview.port || ''}
            onChange={(e) => setPreviewField('port', e.target.value)}
            placeholder={portPlaceholder}
            min="1024"
            max="65535"
            className={inputClass}
            disabled={!enabled}
          />
          {errors['preview.port'] && (
            <p className={errorClass}>
              <AlertCircle size={12} />
              {errors['preview.port']}
            </p>
          )}
          <p className="text-[11px] text-gray-500 mt-1">
            Port the preview command listens on. Falls back to the runtime internal port when empty.
          </p>
        </div>

        <div>
          <label className={labelClass}>Capture routes</label>
          <p className="text-[11px] text-gray-500 mb-2">
            Routes the preview iframe can deep-link into and that the screenshot worker captures.
            Each must start with <span className="font-mono text-gray-300">/</span>.
          </p>
          <div className="space-y-2">
            {captureRoutes.map((row, i) => {
              const routeErr = errors[`preview.captureRoutes.${i}`];
              return (
                <div key={row._id ?? i} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.value || ''}
                      onChange={(e) => onRouteChange(i, e.target.value)}
                      placeholder="/dashboard"
                      className={`flex-1 ${inputClass}`}
                      aria-label={`Capture route ${i + 1}`}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      disabled={!enabled}
                    />
                    <button
                      type="button"
                      onClick={() => onRouteRemove(i)}
                      className="text-red-400 hover:text-red-300 p-2 rounded-lg hover:bg-gray-800 disabled:opacity-50"
                      aria-label={`Remove capture route ${i + 1}`}
                      title="Remove"
                      disabled={!enabled}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {routeErr && (
                    <p className={errorClass}>
                      <AlertCircle size={12} />
                      {routeErr}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onRouteAdd}
            className="mt-2 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 disabled:opacity-50"
            disabled={!enabled}
          >
            <Plus size={12} />
            Add route
          </button>
          {errors['preview.captureRoutes'] && (
            <p className={errorClass}>
              <AlertCircle size={12} />
              {errors['preview.captureRoutes']}
            </p>
          )}
        </div>

        <div>
          <label className={labelClass}>Idle TTL</label>
          <select
            value={ttlValue}
            onChange={(e) => setPreviewField('idleTTL', e.target.value)}
            className={inputClass}
            disabled={!enabled}
            aria-label="Idle TTL preset"
          >
            {PR_ENV_PREVIEW_IDLE_TTL_PRESETS.map((preset) => (
              <option key={preset.seconds} value={String(preset.seconds)}>
                {preset.label}
              </option>
            ))}
            {/* Preserve a saved-but-non-preset value so reopening the
                wizard doesn't silently overwrite it on the next save. */}
            {ttlValue &&
              !PR_ENV_PREVIEW_IDLE_TTL_PRESETS.some((p) => String(p.seconds) === ttlValue) && (
                <option value={ttlValue}>{`${ttlValue}s (custom)`}</option>
              )}
          </select>
          {errors['preview.idleTTL'] && (
            <p className={errorClass}>
              <AlertCircle size={12} />
              {errors['preview.idleTTL']}
            </p>
          )}
          <p className="text-[11px] text-gray-500 mt-1">
            How long the preview runtime stays warm without traffic before it&apos;s torn down.
          </p>
        </div>

        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h6 className="text-xs font-medium text-gray-200">Test it now</h6>
              <p className="text-[11px] text-gray-500">
                Boot the preview for 30 seconds with the settings above and screenshot the first
                capture route. The runtime stops automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={onTestBoot}
              disabled={!enabled || testBoot.status === 'running'}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 flex-shrink-0"
            >
              {testBoot.status === 'running' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <PlayCircle size={12} />
              )}
              {testBoot.status === 'running' ? 'Booting…' : 'Test boot'}
            </button>
          </div>

          {testBoot.status === 'ok' && testBoot.screenshotUrl && (
            <div className="mt-3 space-y-2">
              <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                <CheckCircle2 size={12} />
                Preview booted successfully
              </div>
              <img
                src={testBoot.screenshotUrl}
                alt="Test-boot preview screenshot"
                className="max-h-48 w-full rounded border border-gray-700 object-contain object-top bg-white"
              />
            </div>
          )}

          {testBoot.status === 'error' && (
            <div className="mt-3 space-y-2">
              <p className={errorClass}>
                <AlertCircle size={12} />
                {testBoot.error || 'Preview boot failed'}
              </p>
              {Array.isArray(testBoot.logsTail) && testBoot.logsTail.length > 0 && (
                <pre className="bg-black/40 border border-gray-800 rounded-lg p-2 text-[11px] text-gray-300 font-mono max-h-32 overflow-auto whitespace-pre">
                  {testBoot.logsTail.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Key/value editor for the per-PR container's environment variables.
 * Mirrors the server-side validator in
 * `server/routes/projects.ts:validatePrEnvVars` — duplicate / reserved /
 * malformed keys, oversized values, and over-cap counts surface as
 * field-level errors on Next/Save.
 *
 * Values are masked by default (rendered with `<input type="password">`)
 * since the typical use case is AWS access keys / DB credentials. The
 * eye toggle reveals one row at a time so users can verify what they
 * pasted without exposing every secret on screen.
 */
function EnvVarsEditor({ rows, errors, labelClass, errorClass, onChange, onAdd, onRemove }) {
  const [revealed, setRevealed] = useState(() => new Set());
  const inputRowClass =
    'flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-mono';
  const toggleRevealed = (id) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="border-t border-gray-800 pt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <label className={labelClass}>Environment variables (optional)</label>
          <p className="text-[11px] text-gray-500">
            Passed into the per-PR container as <span className="font-mono">--env KEY=VALUE</span>.
            Use for things like AWS credentials or upstream API URLs. Names must match{' '}
            <span className="font-mono">[A-Z_][A-Z0-9_]*</span>;{' '}
            <span className="font-mono">PORT</span> is reserved. Stored as plaintext in{' '}
            <span className="font-mono">projects.json</span> on the host — prefer instance-role /
            SSM for production secrets.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 flex-shrink-0"
        >
          <Plus size={12} />
          Add variable
        </button>
      </div>

      {rows.length === 0 && (
        <p className="text-[11px] text-gray-600 italic">
          No variables yet. Click &ldquo;Add variable&rdquo; to set one.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row, i) => {
          const id = row._id ?? i;
          const keyErr = errors[`env.${i}.key`];
          const valueErr = errors[`env.${i}.value`];
          const isRevealed = revealed.has(id);
          return (
            <div key={id} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.key || ''}
                  onChange={(e) => onChange(i, { key: e.target.value })}
                  placeholder="AWS_ACCESS_KEY_ID"
                  className={inputRowClass}
                  aria-label={`Variable ${i + 1} name`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <input
                  type={isRevealed ? 'text' : 'password'}
                  value={row.value || ''}
                  onChange={(e) => onChange(i, { value: e.target.value })}
                  placeholder="AKIA…"
                  className={inputRowClass}
                  aria-label={`Variable ${i + 1} value`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  onClick={() => toggleRevealed(id)}
                  className="text-gray-400 hover:text-gray-200 p-2 rounded-lg hover:bg-gray-800"
                  aria-label={isRevealed ? 'Hide value' : 'Show value'}
                  title={isRevealed ? 'Hide value' : 'Show value'}
                >
                  {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  className="text-red-400 hover:text-red-300 p-2 rounded-lg hover:bg-gray-800"
                  aria-label={`Remove variable ${i + 1}`}
                  title="Remove"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {(keyErr || valueErr) && (
                <p className={errorClass}>
                  <AlertCircle size={12} />
                  {keyErr || valueErr}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {errors.env && (
        <p className={errorClass}>
          <AlertCircle size={12} />
          {errors.env}
        </p>
      )}
    </div>
  );
}

function Step2Dockerfile({
  form,
  setField,
  inputClass,
  labelClass,
  dockerfilePreview,
  copied,
  onGenerate,
  onCopy,
  onDownload,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <FileCode size={18} className="text-emerald-400 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-gray-100 mb-1">Custom Dockerfile (optional)</h4>
          <p className="text-xs text-gray-400 leading-relaxed">
            By default, Agent Hub bind-mounts the checkout into{' '}
            <span className="font-mono text-gray-300">node:20-slim</span>. Point at a Dockerfile in
            your repo if your app needs system packages, a non-Node runtime, or a custom build step.
          </p>
        </div>
      </div>

      <div>
        <label className={labelClass}>Dockerfile path (relative to repo root)</label>
        <input
          type="text"
          value={form.dockerfilePath}
          onChange={(e) => setField('dockerfilePath', e.target.value)}
          placeholder="Dockerfile, docker/preview.Dockerfile, ..."
          className={inputClass}
        />
        <p className="text-[11px] text-gray-500 mt-1">
          Leave blank to use the default base image with your start command.
        </p>
      </div>

      <div className="border-t border-gray-800 pt-4 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="text-sm font-medium text-gray-200">Need a Dockerfile?</h5>
            <p className="text-[11px] text-gray-500">
              Generate a starter from your settings — copy or download into your repo.
            </p>
          </div>
          <button
            type="button"
            onClick={onGenerate}
            className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1"
          >
            <FileCode size={12} />
            Generate Dockerfile
          </button>
        </div>

        {dockerfilePreview && (
          <div className="space-y-2">
            <pre className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-[11px] text-gray-300 font-mono overflow-x-auto whitespace-pre">
              {dockerfilePreview}
            </pre>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs px-3 py-1.5 rounded-lg flex items-center gap-1"
              >
                <Copy size={12} />
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={onDownload}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs px-3 py-1.5 rounded-lg flex items-center gap-1"
              >
                <Download size={12} />
                Download
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
