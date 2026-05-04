import { useState, useMemo, useEffect } from 'react';
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
} from 'lucide-react';
import { api } from '../utils/api.js';
import {
  formFromConfig,
  validateForm,
  generateDefaultDockerfile,
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
export default function PrEnvProjectWizard({ project, onClose, onSaved, showToast }) {
  const initialForm = useMemo(() => formFromConfig(project?.prEnv), [project]);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [dockerfilePreview, setDockerfilePreview] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset preview when the user changes inputs that feed into it.
  useEffect(() => {
    setDockerfilePreview('');
  }, [form.setupCommand, form.startScript, form.internalPort]);

  if (!project) return null;

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
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

function Step1Runtime({ form, setField, errors, inputClass, labelClass, errorClass }) {
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
        <label className={labelClass}>Start command / script *</label>
        <input
          type="text"
          value={form.startScript}
          onChange={(e) => setField('startScript', e.target.value)}
          placeholder="npm start, ./scripts/pr-env.sh, node server.js, ..."
          className={inputClass}
        />
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
