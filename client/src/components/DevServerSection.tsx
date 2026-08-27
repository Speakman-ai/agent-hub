import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  Key,
  Network,
  Save,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { api } from '../utils/api';
import RunningPreviewsPanel from './RunningPreviewsPanel';
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

const inputClass =
  'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
const smallInputClass =
  'w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-100 font-mono focus:outline-none focus:border-gray-600';

/**
 * Settings form for the managed dev-server config (`prEnv.devServer`).
 *
 * Fields mirror `server/dev-server-config.ts`: start command, non-secret
 * env rows, secret-key references (write-only — masked on read, never
 * round-tripping plaintext), internal→proxy port map with labels, health
 * path, and ready timeout. Validation mirrors the server Zod schema so
 * bad input surfaces before the PATCH.
 */
export default function DevServerSection({ projects = [], onProjectsChange, onOpenSession }: any) {
  const project = projects?.[0] || null;
  const projectId = project?.id || '';

  const [form, setForm] = useState<DevServerForm>(() =>
    project ? devServerFormFromProject(project, []) : emptyDevServerForm(),
  );
  const [existingSecrets, setExistingSecrets] = useState<StoredSecret[]>([]);
  // Whether the project-secrets snapshot loaded successfully. Saving is
  // blocked until it does: a secrets PUT is a full replace built from this
  // snapshot, so saving against a failed (empty) load would delete every
  // previously stored project secret not referenced in the form.
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const projectRef = useRef(project);
  projectRef.current = project;

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const secretsRes = await api.getProjectSecrets(projectId);
      const secrets: StoredSecret[] = Array.isArray(secretsRes?.secrets) ? secretsRes.secrets : [];
      setExistingSecrets(secrets);
      setSecretsLoaded(true);
      setForm(devServerFormFromProject(projectRef.current, secrets));
    } catch (err: any) {
      // Do NOT silently fall back to an empty secret list — that would make a
      // later save issue a full-replace PUT that wipes stored secrets. Keep
      // the config viewable but block saving until secrets load (Reload).
      setSecretsLoaded(false);
      setExistingSecrets([]);
      setForm(devServerFormFromProject(projectRef.current, []));
      setError(
        `Could not load existing project secrets${
          err?.message ? ` (${err.message})` : ''
        }. Saving is disabled until secrets load — click Reload to retry. Saving now could overwrite stored secrets.`,
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The Agent walkthrough persists prEnv.devServer + secrets server-side and
  // pings wizard-complete; reload so the form reflects what the agent saved.
  useEffect(() => {
    const handler = (e: any) => {
      const pid = e?.detail?.projectId;
      if (pid && projectRef.current?.id === pid) {
        void load();
        if (typeof onProjectsChange === 'function') onProjectsChange();
      }
    };
    window.addEventListener('agenthub:dev_server_wizard_complete', handler);
    return () => window.removeEventListener('agenthub:dev_server_wizard_complete', handler);
  }, [load, onProjectsChange]);

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
      if (typeof onOpenSession === 'function') {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      } else {
        setWizardError(
          `Walkthrough started (session ${res.sessionId}) — open it from the agent session list.`,
        );
      }
    } catch (err: any) {
      setWizardError(err?.message || 'Failed to start setup walkthrough');
    } finally {
      setWizardStarting(false);
    }
  }, [project, wizardStarting, onOpenSession]);

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

  // secret rows
  // A `secret`-kind value is stored for this key in the project store.
  const keyHasStoredSecret = (key: string) =>
    existingSecrets.some((s) => s.key === key.trim() && s.kind === 'secret');
  const updateSecretRow = (idx: number, patch: any) =>
    setForm((prev) => ({
      ...prev,
      secretRows: prev.secretRows.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch };
        // Recompute `hadSecret` whenever the key changes: renaming a stored
        // secret to a key with no stored value must clear the flag, else
        // validation would treat the new key as already stored and save a
        // dangling `secretKeys` reference with no backing secret.
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
  const setPrimaryPort = (idx: number, primary: boolean) =>
    setForm((prev) => ({
      ...prev,
      portRows: prev.portRows.map((r, i) => ({ ...r, primary: primary && i === idx })),
    }));

  const handleSave = async () => {
    if (!project || saving) return;
    if (!secretsLoaded) {
      // Guard against a full-replace secrets PUT built from an incomplete
      // (failed-load) snapshot, which could delete stored project secrets.
      setError('Project secrets have not loaded — click Reload before saving.');
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
      // 1. Persist any freshly-typed secret values (write-only). Unchanged
      //    secret rows are preserved via the MASK sentinel — plaintext is
      //    never re-sent. Secrets are written first so the config PATCH never
      //    references a secret the store lacks (no dangling reference).
      const secretsPayload = buildSecretsPutPayload(form, existingSecrets);
      let secretsWritten = false;
      if (secretsPayload) {
        await api.putProjectSecrets(projectId, secretsPayload);
        secretsWritten = true;
      }
      // 2. Persist the dev-server config via the project PATCH endpoint,
      //    preserving any sibling prEnv config already saved. The two writes
      //    are not atomic server-side, so if the PATCH fails after secrets
      //    were written we compensate by restoring the pre-save secrets
      //    snapshot — otherwise a freshly-typed secret would linger with no
      //    config reference (orphaned data / inconsistent config).
      const devServer = buildDevServerConfig(form);
      const previousPrEnv = (project.prEnv || {}) as Record<string, any>;
      const { preview: _legacyPreview, ...prEnvWithoutLegacyPreview } = previousPrEnv;
      const prEnv = { ...prEnvWithoutLegacyPreview, devServer };
      try {
        await api.updateProject(projectId, { prEnv });
      } catch (patchErr) {
        if (secretsWritten) {
          try {
            // A secrets PUT is a full replace, so PUTting the pre-save
            // snapshot (empty when there were none) drops the just-written
            // key and restores prior values via the MASK sentinel.
            await api.putProjectSecrets(
              projectId,
              buildSecretsSnapshotPayload(existingSecrets) ?? [],
            );
          } catch {
            // Best-effort compensation; surface the original PATCH error.
          }
        }
        throw patchErr;
      }

      // Re-derive the form from the payload we just persisted — NOT from a
      // reload that reads `projectRef.current`, which still points at the
      // pre-save project prop until the parent refetch propagates and would
      // otherwise clobber the user's just-saved edits. `secretsPayload`
      // already merges existing + freshly-stored secret keys, so referenced
      // secrets now render as stored (`hadSecret`) with their write-only
      // value inputs cleared.
      const mergedSecrets: StoredSecret[] = secretsPayload
        ? secretsPayload.map((s) => ({ key: s.key, kind: s.kind }))
        : existingSecrets;
      setExistingSecrets(mergedSecrets);
      setForm(devServerFormFromProject({ prEnv }, mergedSecrets));

      setSaved(true);
      // Refresh the parent's project list so other views observe the change;
      // the local form state above is already authoritative for this view.
      if (typeof onProjectsChange === 'function') onProjectsChange();
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err?.message || 'Failed to save dev-server config');
    } finally {
      setSaving(false);
    }
  };

  if (!projects?.length || !project) {
    return <p className="text-sm text-gray-500">No project selected.</p>;
  }

  return (
    <div className="space-y-6 pb-28" data-testid="dev-server-section">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Terminal size={18} className="text-emerald-400" />
          Dev server
        </h3>
        <p className="text-xs text-gray-500 max-w-2xl">
          Agent Hub runs your app as a managed long-lived process from the{' '}
          <strong className="text-gray-300">start command</strong> inside the session env.
          Non-secret env and referenced secrets are injected at spawn; mapped internal ports are
          exposed through the authenticated preview proxy.
        </p>
        <div className="flex items-center gap-3 text-sm mt-3">
          <button
            type="button"
            onClick={() => void handleStartWalkthrough()}
            disabled={wizardStarting || !project}
            className="flex items-center gap-1.5 text-xs bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-300 border border-emerald-700/40 rounded-lg px-3 py-1.5 disabled:opacity-50"
            data-testid="dev-server-walkthrough"
          >
            {wizardStarting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Sparkles size={13} />
            )}
            {wizardStarting ? 'Starting…' : 'Agent walkthrough'}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
            data-testid="dev-server-reload"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Reload
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-2 max-w-2xl">
          Not sure what to fill in? <strong className="text-gray-300">Agent walkthrough</strong>{' '}
          opens a guided chat session that scans the repo, confirms the start command, ports, and
          env/secret split with you, and saves the config for you. It also checks the app is
          reachable from a preview browser, which is the part this form can&apos;t do for you.
        </p>
        <p className="text-[11px] text-gray-500 mt-2 max-w-2xl">
          Configuring by hand? The preview browser is not on the machine running your app, so it
          needs to bind <code className="text-gray-400">0.0.0.0</code>, allow the proxied{' '}
          <code className="text-gray-400">Host</code> header, and reach its own API by a relative or
          same-origin URL rather than <code className="text-gray-400">localhost</code>. A hardcoded
          loopback API URL is the common one: the page loads and every request fails, so the preview
          looks healthy.
        </p>
        {wizardError && (
          <p
            className="text-xs text-red-400 flex items-center gap-2 mt-2"
            data-testid="dev-server-walkthrough-error"
          >
            <AlertCircle size={13} /> {wizardError}
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 flex items-center gap-2" data-testid="dev-server-error">
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {/* Build command (optional) */}
      <section className="rounded-lg border border-gray-800 p-4 space-y-3">
        <label
          htmlFor="dev-server-build-command"
          className="block text-sm font-medium text-gray-200"
        >
          Build command <span className="text-gray-500 font-normal">(optional)</span>
        </label>
        <input
          id="dev-server-build-command"
          type="text"
          value={form.buildCommand}
          onChange={(e) => setField('buildCommand', e.target.value)}
          placeholder="docker compose build"
          className={`${inputClass} font-mono`}
          data-testid="dev-server-build-command"
        />
        <p className="text-[11px] text-gray-500">
          Runs once before the start command (after any apt packages). Leave blank if there is
          nothing to build. <strong>Restart Server</strong> reuses the last build;{' '}
          <strong>Rebuild App</strong> re-runs this first.
        </p>
      </section>

      {/* Start command */}
      <section className="rounded-lg border border-gray-800 p-4 space-y-3">
        <label
          htmlFor="dev-server-start-command"
          className="block text-sm font-medium text-gray-200"
        >
          Start command
        </label>
        <input
          id="dev-server-start-command"
          type="text"
          value={form.startCommand}
          onChange={(e) => setField('startCommand', e.target.value)}
          placeholder="npm run dev"
          className={`${inputClass} font-mono`}
          data-testid="dev-server-start-command"
        />
        <p className="text-[11px] text-gray-500">
          Run via <code>sh -c</code> from the working directory below (or the worktree root). The
          Hub publishes a per-session host port as <code>AGENT_HUB_HOST_PORT</code> — a
          compose-based server can bind <code>${'{AGENT_HUB_HOST_PORT}'}</code> instead of a
          hardcoded port so two sessions never collide.
        </p>
      </section>

      {/* Working directory + health + timeout */}
      <section className="rounded-lg border border-gray-800 p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label htmlFor="dev-server-cwd" className="block text-xs text-gray-400 mb-1">
            Working directory (optional)
          </label>
          <input
            id="dev-server-cwd"
            type="text"
            value={form.cwd}
            onChange={(e) => setField('cwd', e.target.value)}
            placeholder="apps/web"
            className={`${inputClass} font-mono`}
            data-testid="dev-server-cwd"
          />
        </div>
        <div>
          <label htmlFor="dev-server-health-path" className="block text-xs text-gray-400 mb-1">
            Health path (optional)
          </label>
          <input
            id="dev-server-health-path"
            type="text"
            value={form.healthPath}
            onChange={(e) => setField('healthPath', e.target.value)}
            placeholder="/"
            className={`${inputClass} font-mono`}
            data-testid="dev-server-health-path"
          />
        </div>
        <div>
          <label htmlFor="dev-server-ready-timeout" className="block text-xs text-gray-400 mb-1">
            Ready timeout (ms)
          </label>
          <input
            id="dev-server-ready-timeout"
            type="number"
            min={READY_TIMEOUT_MIN_MS}
            max={READY_TIMEOUT_MAX_MS}
            step={1000}
            value={form.readyTimeoutMs}
            onChange={(e) => setField('readyTimeoutMs', e.target.value)}
            placeholder="server default"
            className={inputClass}
            data-testid="dev-server-ready-timeout"
          />
        </div>
      </section>

      {/* System (apt) packages */}
      <section className="rounded-lg border border-gray-800 p-4">
        <label htmlFor="dev-server-apt-packages" className="block text-xs text-gray-400 mb-1">
          System packages (apt, optional)
        </label>
        <textarea
          id="dev-server-apt-packages"
          rows={2}
          value={form.aptPackagesText}
          onChange={(e) => setField('aptPackagesText', e.target.value)}
          placeholder="imagemagick libmagickwand-dev"
          className={`${inputClass} font-mono`}
          data-testid="dev-server-apt-packages"
        />
        <p className="text-[11px] text-gray-500 mt-2 max-w-2xl">
          OS-level libraries the app needs that pip/npm can&apos;t install (e.g. ImageMagick for
          Python Wand). Separate names with spaces or newlines. Installed with <code>apt-get</code>{' '}
          before the start command — but only when this Hub runs the sysbox session backend; on the
          host backend the install is skipped with a warning in the preview logs.
        </p>
      </section>

      {/* Pull request previews */}
      <section className="rounded-lg border border-gray-800 p-4">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.previewOnPullRequests}
            onChange={(e) => setField('previewOnPullRequests', e.target.checked)}
            className="mt-0.5"
            data-testid="dev-server-preview-on-prs"
          />
          <span>
            <span className="block text-sm text-gray-200">Show previews on all pull requests</span>
            <span className="block text-[11px] text-gray-500 mt-0.5 max-w-2xl">
              Surface preview state on every native pull request by default. The &ldquo;Enable
              preview&rdquo; control is always available on Hub-hosted PRs when a start command is
              set; this only auto-opens the preview section without the reviewer expanding it first.
            </span>
          </span>
        </label>
      </section>

      {/* Env vars */}
      <section
        className="rounded-lg border border-gray-800 p-4 space-y-3"
        data-testid="dev-server-env-section"
      >
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-200">Environment variables</h4>
          <button
            type="button"
            onClick={addEnvRow}
            className="text-xs text-sky-400 hover:text-sky-300"
            data-testid="dev-server-env-add"
          >
            Add variable
          </button>
        </div>
        {form.envRows.length === 0 && (
          <p className="text-xs text-gray-500">No non-secret env variables.</p>
        )}
        <div className="space-y-2">
          {form.envRows.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 items-center"
              data-testid="dev-server-env-row"
            >
              <input
                type="text"
                value={row.key}
                onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                placeholder="KEY"
                aria-label="env key"
                className={`col-span-4 ${smallInputClass}`}
              />
              <input
                type="text"
                value={row.value}
                onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                placeholder="value"
                aria-label="env value"
                className={`col-span-7 ${smallInputClass}`}
              />
              <button
                type="button"
                onClick={() => removeEnvRow(idx)}
                className="col-span-1 text-gray-500 hover:text-red-400"
                aria-label="Remove env variable"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Secret keys */}
      <section
        className="rounded-lg border border-gray-800 p-4 space-y-3"
        data-testid="dev-server-secrets-section"
      >
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2">
            <Key size={14} className="text-violet-400" />
            Secret references
          </h4>
          <button
            type="button"
            onClick={addSecretRow}
            className="text-xs text-sky-400 hover:text-sky-300"
            data-testid="dev-server-secret-add"
          >
            Add secret
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          Names of encrypted project secrets injected into the process env at spawn. Values are
          write-only — a stored secret is masked and never returned. Leave the value blank to keep
          the current value.
        </p>
        {form.secretRows.length === 0 && (
          <p className="text-xs text-gray-500">No secret references.</p>
        )}
        <div className="space-y-2">
          {form.secretRows.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 items-center"
              data-testid="dev-server-secret-row"
            >
              <input
                type="text"
                value={row.key}
                onChange={(e) => updateSecretRow(idx, { key: e.target.value })}
                placeholder="SECRET_KEY"
                aria-label="secret key"
                className={`col-span-4 ${smallInputClass}`}
              />
              <input
                type="password"
                value={row.value}
                onChange={(e) => updateSecretRow(idx, { value: e.target.value })}
                placeholder={row.hadSecret ? '•••••••• (stored — blank keeps it)' : 'value'}
                aria-label="secret value"
                autoComplete="new-password"
                className={`col-span-6 ${smallInputClass}`}
                data-testid="dev-server-secret-value"
              />
              <span
                className="col-span-1 flex justify-center text-[10px]"
                data-testid="dev-server-secret-status"
              >
                {row.hadSecret ? (
                  <span className="text-emerald-400" title="Stored">
                    set
                  </span>
                ) : (
                  <span className="text-gray-600" title="Not stored">
                    —
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeSecretRow(idx)}
                className="col-span-1 text-gray-500 hover:text-red-400"
                aria-label="Remove secret reference"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Port map */}
      <section
        className="rounded-lg border border-gray-800 p-4 space-y-3"
        data-testid="dev-server-ports-section"
      >
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2">
            <Network size={14} className="text-sky-400" />
            Port map
          </h4>
          <button
            type="button"
            onClick={addPortRow}
            className="text-xs text-sky-400 hover:text-sky-300"
            data-testid="dev-server-port-add"
          >
            Add port
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          Internal ports exposed through the authenticated preview proxy. The primary port keeps the{' '}
          <code>/preview/proxy/</code> mount; extra ports get{' '}
          <code>/preview/proxy/p/&lt;port&gt;/</code>.
        </p>
        {form.portRows.length === 0 && <p className="text-xs text-gray-500">No mapped ports.</p>}
        <div className="space-y-2">
          {form.portRows.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 items-center"
              data-testid="dev-server-port-row"
            >
              <input
                type="number"
                min={1}
                max={65535}
                value={row.internalPort}
                onChange={(e) => updatePortRow(idx, { internalPort: e.target.value })}
                placeholder="3000"
                aria-label="internal port"
                className={`col-span-3 ${smallInputClass}`}
              />
              <input
                type="text"
                value={row.label}
                onChange={(e) => updatePortRow(idx, { label: e.target.value })}
                placeholder="web"
                aria-label="port label"
                className={`col-span-6 ${smallInputClass}`}
              />
              <label className="col-span-2 flex items-center gap-1 text-[11px] text-gray-400">
                <input
                  type="radio"
                  name="dev-server-primary-port"
                  checked={row.primary}
                  onChange={(e) => setPrimaryPort(idx, e.target.checked)}
                  aria-label="primary port"
                />
                primary
              </label>
              <button
                type="button"
                onClick={() => removePortRow(idx)}
                className="col-span-1 text-gray-500 hover:text-red-400"
                aria-label="Remove port"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {projectId && <RunningPreviewsPanel projectId={projectId} onOpenSession={onOpenSession} />}

      <div className="fixed bottom-0 left-0 right-0 md:left-64 z-20 flex items-center gap-3 px-6 py-4 bg-gray-950/95 border-t border-gray-800 backdrop-blur">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading || !secretsLoaded}
          title={!secretsLoaded ? 'Project secrets have not loaded — click Reload' : undefined}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg"
          data-testid="dev-server-save"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {saving ? 'Saving…' : 'Save dev-server config'}
        </button>
        {saved && (
          <span
            className="text-sm text-emerald-400 flex items-center gap-1"
            data-testid="dev-server-saved"
          >
            <CheckCircle2 size={16} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
