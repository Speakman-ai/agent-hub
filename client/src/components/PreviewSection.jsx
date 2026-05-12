import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Monitor,
  RefreshCw,
  Save,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  Plus,
  Play,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Settings → Preview
 *
 * Surface to configure `project.prEnv.preview` (and the shared
 * `project.prEnv.healthPath`) without hand-editing `projects.json`.
 *
 * Backed by the existing PATCH /api/projects/:id route — validation
 * lives in `server/routes/projects.ts:validatePrEnvProjectConfig` and
 * `validatePrEnvPreview`. We surface 400 errors inline against the
 * field that triggered them when possible, falling back to a generic
 * banner.
 *
 * Re-detect button calls `POST /api/projects/:id/preview/detect` (a
 * pure read of the project's checkout) and shows a suggestion the user
 * can accept-overwrite or dismiss.
 */

// Bounds mirror server-side validators. Keep in lockstep with
// PR_ENV_PREVIEW_* constants in `server/routes/projects.ts`.
const PREVIEW_IDLE_TTL_MIN = 60;
const PREVIEW_IDLE_TTL_MAX = 86400;
const PREVIEW_MAX_ROUTES = 10;
// Worktree-preview port allocator range (DEFAULT_PREVIEW_PORT_RANGE in
// `server/preview/preview-schema.ts`). Surfaced read-only so users
// understand the runtime allocates dynamically; the legacy
// `prEnv.preview.port` override is intentionally not exposed in this
// panel — the worktree runtime ignores it and chooses from this range.
const PREVIEW_PORT_RANGE_MIN = 4100;
const PREVIEW_PORT_RANGE_MAX = 4999;

const DEFAULT_FORM = Object.freeze({
  enabled: false,
  startScript: 'npm run dev',
  healthPath: '/',
  idleTTL: 600,
  captureRoutes: ['/'],
});

function formFromProject(project) {
  if (!project) return { ...DEFAULT_FORM };
  const prEnv = project.prEnv || {};
  const preview = prEnv.preview || {};
  return {
    enabled: !!preview.enabled,
    startScript: preview.startScript || prEnv.startScript || DEFAULT_FORM.startScript,
    healthPath: prEnv.healthPath || DEFAULT_FORM.healthPath,
    idleTTL:
      typeof preview.idleTTL === 'number' && Number.isFinite(preview.idleTTL)
        ? preview.idleTTL
        : DEFAULT_FORM.idleTTL,
    captureRoutes:
      Array.isArray(preview.captureRoutes) && preview.captureRoutes.length > 0
        ? [...preview.captureRoutes]
        : [...DEFAULT_FORM.captureRoutes],
  };
}

/**
 * Build the PATCH payload for the project. We always preserve any
 * existing parent prEnv.enabled/startScript/internalPort so toggling
 * the worktree-preview switch doesn't accidentally drop a separately-
 * configured PR-env block (legacy installs may still carry one).
 */
function buildPatchPayload(form, project) {
  const prevPrEnv = project?.prEnv || {};
  const preview = {
    enabled: !!form.enabled,
  };
  if (form.enabled) {
    const startScript = (form.startScript || '').trim();
    if (startScript) preview.startScript = startScript;
    const idleTTL = Number(form.idleTTL);
    if (Number.isInteger(idleTTL)) preview.idleTTL = idleTTL;
    const routes = (form.captureRoutes || [])
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean);
    if (routes.length > 0) preview.captureRoutes = routes;
  }
  const payload = {
    prEnv: {
      ...prevPrEnv,
      enabled: prevPrEnv.enabled ?? false,
      preview,
    },
  };
  const healthPath = (form.healthPath || '').trim();
  if (healthPath) payload.prEnv.healthPath = healthPath;
  else delete payload.prEnv.healthPath;
  return payload;
}

function shallowEqualForm(a, b) {
  if (!a || !b) return a === b;
  if (a.enabled !== b.enabled) return false;
  if ((a.startScript || '') !== (b.startScript || '')) return false;
  if ((a.healthPath || '') !== (b.healthPath || '')) return false;
  if (Number(a.idleTTL) !== Number(b.idleTTL)) return false;
  const ar = a.captureRoutes || [];
  const br = b.captureRoutes || [];
  if (ar.length !== br.length) return false;
  for (let i = 0; i < ar.length; i++) {
    if ((ar[i] || '') !== (br[i] || '')) return false;
  }
  return true;
}

export default function PreviewSection({
  projects = [],
  onProjectsChange,
  registerGuard,
  onOpenSession,
}) {
  const [projectId, setProjectId] = useState(projects?.[0]?.id || '');
  const [project, setProject] = useState(projects?.find((p) => p.id === projectId) || null);
  const [form, setForm] = useState(() => formFromProject(project));
  const [baseline, setBaseline] = useState(() => formFromProject(project));
  const [routeDraft, setRouteDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [suggestion, setSuggestion] = useState(null); // { stack, startScript, port, captureRoutes, idleTTL } | { empty: true }
  const [detectError, setDetectError] = useState(null);
  // Test-preview state.
  //   testPhase: null → 'starting' → 'health' → 'ready' | 'failed'
  //   testResult: server response on completion (success or failure)
  const [testPhase, setTestPhase] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Refresh local project record when the projects prop or selection changes.
  useEffect(() => {
    const found = projects?.find((p) => p.id === projectId) || null;
    setProject(found);
    const next = formFromProject(found);
    setForm(next);
    setBaseline(next);
    setSaveError(null);
    setSaveStatus(null);
    setSuggestion(null);
    setDetectError(null);
    // Reset test panel when switching projects so a stale Ready/Failed
    // banner from a different project doesn't linger.
    setTestPhase(null);
    setTestResult(null);
  }, [projectId, projects]);

  // If the selected project disappeared (deleted, etc.), pick the first.
  useEffect(() => {
    if (!projects?.length) return;
    if (!projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  const dirty = useMemo(() => !shallowEqualForm(form, baseline), [form, baseline]);

  // Unsaved-changes guard — parent passes a `registerGuard(fn)` ref that
  // returns true to allow tab change, false to block. We expose a guard
  // that prompts the user via window.confirm when dirty.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (typeof registerGuard !== 'function') return undefined;
    const guard = () => {
      if (!dirtyRef.current) return true;

      return window.confirm('You have unsaved Preview settings. Discard changes?');
    };
    registerGuard(guard);
    return () => registerGuard(null);
  }, [registerGuard]);

  // beforeunload — also warn on full page unload while dirty.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const addRoute = () => {
    const trimmed = (routeDraft || '').trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('/')) {
      setSaveError('captureRoutes entries must start with `/`');
      return;
    }
    if (form.captureRoutes.length >= PREVIEW_MAX_ROUTES) {
      setSaveError(`captureRoutes supports at most ${PREVIEW_MAX_ROUTES} entries`);
      return;
    }
    if (form.captureRoutes.includes(trimmed)) {
      setRouteDraft('');
      return;
    }
    setSaveError(null);
    setForm((prev) => ({ ...prev, captureRoutes: [...prev.captureRoutes, trimmed] }));
    setRouteDraft('');
  };

  const removeRoute = (idx) => {
    setForm((prev) => ({
      ...prev,
      captureRoutes: prev.captureRoutes.filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    setSaveError(null);
    setSaveStatus(null);
    try {
      const payload = buildPatchPayload(form, project);
      const updated = await api.updateProject(project.id, payload);
      const next = formFromProject(updated);
      setForm(next);
      setBaseline(next);
      setProject(updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2500);
      if (typeof onProjectsChange === 'function') onProjectsChange();
    } catch (err) {
      const msg = err?.message || 'Failed to save preview settings';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDetect = async () => {
    if (!project) return;
    setDetecting(true);
    setDetectError(null);
    setSuggestion(null);
    try {
      const res = await api.detectProjectPreview(project.id);
      const detected = res?.detected || null;
      setSuggestion(detected ? detected : { empty: true });
    } catch (err) {
      setDetectError(err?.message || 'Failed to detect preview defaults');
    } finally {
      setDetecting(false);
    }
  };

  const acceptSuggestion = () => {
    if (!suggestion || suggestion.empty) {
      setSuggestion(null);
      return;
    }
    setForm((prev) => ({
      ...prev,
      startScript: suggestion.startScript || prev.startScript,
      idleTTL:
        typeof suggestion.idleTTL === 'number' && Number.isFinite(suggestion.idleTTL)
          ? suggestion.idleTTL
          : prev.idleTTL,
      captureRoutes:
        Array.isArray(suggestion.captureRoutes) && suggestion.captureRoutes.length > 0
          ? [...suggestion.captureRoutes]
          : prev.captureRoutes,
    }));
    setSuggestion(null);
  };

  const dismissSuggestion = () => setSuggestion(null);

  // Test preview — runs the configured startScript + healthPath against
  // the project's `cwd` in a one-shot runtime, captures a screenshot,
  // and tears down. Disabled while the form is dirty (user must Save
  // first so the server is testing the saved config rather than the
  // unsaved draft).
  const isTesting = testPhase === 'starting' || testPhase === 'health';

  const handleTest = async () => {
    if (!project || isTesting) return;
    setTestPhase('starting');
    setTestResult(null);
    // Flip the visible label to "Health check…" after a short tick so
    // the user can see the phase progress; this is a cosmetic indicator
    // because the server runs both phases inside one HTTP call.
    const healthTimer = setTimeout(() => {
      setTestPhase((prev) => (prev === 'starting' ? 'health' : prev));
    }, 800);
    try {
      const result = await api.testProjectPreview(project.id);
      setTestResult(result);
      setTestPhase(result?.ok ? 'ready' : 'failed');
    } catch (err) {
      setTestResult({ ok: false, error: err?.message || 'Preview test failed' });
      setTestPhase('failed');
    } finally {
      clearTimeout(healthTimer);
    }
  };

  const clearTestResult = () => {
    setTestPhase(null);
    setTestResult(null);
  };

  // AI Setup wizard — spawn an interactive session that walks the user
  // through configuring preview defaults. Server returns
  // `{ sessionId, agentId }` and we delegate to the parent (settings
  // page) to actually navigate / open the chat panel for that session.
  // Falls back to setting an error banner if the parent didn't supply
  // an `onOpenSession` handler.
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const handleAISetup = async () => {
    if (!project || wizardStarting) return;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startPreviewWizard(project.id);
      if (typeof onOpenSession === 'function' && res?.sessionId) {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      } else {
        setWizardError(
          res?.sessionId
            ? 'Wizard session started but no session handler is available'
            : 'Server did not return a wizard session id',
        );
      }
    } catch (err) {
      setWizardError(err?.message || 'Failed to start preview wizard');
    } finally {
      setWizardStarting(false);
    }
  };

  // Refetch projects when the wizard's session signals it persisted
  // changes (the SKILL.md instructs the agent to ping
  // `/preview/wizard-complete` after PUT-ing). Wire up via a window
  // event — the App-level WS handler bridges the broadcast onto a
  // DOM CustomEvent for components to listen on without each having to
  // open its own socket.
  useEffect(() => {
    const handler = (e) => {
      const pid = e?.detail?.projectId;
      if (!pid) return;
      if (project?.id && pid === project.id) {
        if (typeof onProjectsChange === 'function') onProjectsChange();
      }
    };
    window.addEventListener('agenthub:preview_wizard_complete', handler);
    return () => window.removeEventListener('agenthub:preview_wizard_complete', handler);
  }, [project?.id, onProjectsChange]);

  if (!projects?.length) {
    return (
      <p className="text-sm text-gray-500">
        No projects yet — create one to configure Preview settings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Monitor size={18} className="text-sky-400" />
          Preview
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          Configure the per-session worktree preview the agent boots when it emits{' '}
          <code className="text-gray-300">{'<agenthub:preview>'}</code>. Allocation is dynamic
          inside the {PREVIEW_PORT_RANGE_MIN}–{PREVIEW_PORT_RANGE_MAX} port range.
        </p>

        <label className="flex items-center gap-2 text-sm mb-4">
          <span className="text-gray-400">Project:</span>
          <select
            value={projectId}
            onChange={(e) => {
              if (dirty && !window.confirm('Discard unsaved Preview changes?')) return;
              setProjectId(e.target.value);
            }}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            data-testid="preview-project-select"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {project && (
        <div className="space-y-5">
          {/* Enabled toggle */}
          <div className="flex items-start justify-between gap-4 bg-gray-800/40 border border-gray-800 rounded-xl p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-200">Enable preview</p>
              <p className="text-xs text-gray-500 mt-0.5">
                When on, agents in this project may spawn an in-session preview against the active
                worktree.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              onClick={() => setField('enabled', !form.enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                form.enabled ? 'bg-sky-500' : 'bg-gray-700'
              }`}
              data-testid="preview-enabled-toggle"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
                  form.enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* startScript */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Start script</label>
            <p className="text-xs text-gray-500 mb-2">
              Shell command run inside the session worktree to boot the dev server. Defaults to{' '}
              <code className="text-gray-300">npm run dev</code>.
            </p>
            <input
              type="text"
              value={form.startScript}
              onChange={(e) => setField('startScript', e.target.value)}
              placeholder="npm run dev"
              disabled={!form.enabled}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono disabled:opacity-50"
              data-testid="preview-start-script"
            />
          </div>

          {/* healthPath */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Health path</label>
            <p className="text-xs text-gray-500 mb-2">
              HTTP path the runtime polls until the dev server is reachable. Must start with
              <code className="text-gray-300"> /</code>. Defaults to{' '}
              <code className="text-gray-300">/</code>.
            </p>
            <input
              type="text"
              value={form.healthPath}
              onChange={(e) => setField('healthPath', e.target.value)}
              placeholder="/"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
              data-testid="preview-health-path"
            />
          </div>

          {/* idleTTL */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">
              Idle TTL (seconds)
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Seconds of inactivity before the preview is reaped. Bounded {PREVIEW_IDLE_TTL_MIN}–
              {PREVIEW_IDLE_TTL_MAX}. Defaults to 600 (10&nbsp;min).
            </p>
            <input
              type="number"
              value={form.idleTTL}
              min={PREVIEW_IDLE_TTL_MIN}
              max={PREVIEW_IDLE_TTL_MAX}
              onChange={(e) =>
                setField('idleTTL', e.target.value === '' ? '' : Number(e.target.value))
              }
              disabled={!form.enabled}
              className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono disabled:opacity-50"
              data-testid="preview-idle-ttl"
            />
          </div>

          {/* captureRoutes */}
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Capture routes</label>
            <p className="text-xs text-gray-500 mb-2">
              Routes (max {PREVIEW_MAX_ROUTES}) the screenshot worker visits when capturing
              previews. Each entry must start with <code className="text-gray-300">/</code>.
            </p>
            <div className="flex flex-wrap gap-2 mb-2" data-testid="preview-routes-list">
              {form.captureRoutes.map((route, idx) => (
                <span
                  key={`${route}-${idx}`}
                  className="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-full px-3 py-1 text-xs font-mono text-gray-200"
                >
                  {route}
                  <button
                    type="button"
                    onClick={() => removeRoute(idx)}
                    aria-label={`Remove route ${route}`}
                    className="text-gray-500 hover:text-red-400"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {form.captureRoutes.length === 0 && (
                <span className="text-xs text-gray-500 italic">No routes configured.</span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={routeDraft}
                onChange={(e) => setRouteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addRoute();
                  }
                }}
                placeholder="/about"
                disabled={!form.enabled || form.captureRoutes.length >= PREVIEW_MAX_ROUTES}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono disabled:opacity-50"
                data-testid="preview-route-input"
              />
              <button
                type="button"
                onClick={addRoute}
                disabled={!form.enabled || form.captureRoutes.length >= PREVIEW_MAX_ROUTES}
                className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-3 py-2 rounded-lg"
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>

          {/* Read-only port range */}
          <div className="bg-gray-800/40 border border-gray-800 rounded-xl p-4">
            <p className="text-sm font-medium text-gray-200 mb-1">Runtime port range</p>
            <p className="text-xs text-gray-500">
              The preview runtime allocates a host port dynamically inside{' '}
              <code className="text-gray-300">
                {PREVIEW_PORT_RANGE_MIN}–{PREVIEW_PORT_RANGE_MAX}
              </code>
              . Per-project port overrides are not honoured for worktree previews — the allocator
              picks the next free port at boot.
            </p>
          </div>

          {/* Re-detect */}
          <div className="bg-gray-800/40 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-200">Re-detect from repo</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Sniff the project&apos;s checkout for a recognised stack (Vite, Next, CRA, Astro,
                  Nuxt, Expo) and suggest defaults you can accept or dismiss.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDetect}
                disabled={detecting}
                className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-3 py-2 rounded-lg shrink-0"
                data-testid="preview-detect-button"
              >
                {detecting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                Re-detect
              </button>
            </div>
            {detectError && (
              <div className="flex items-start gap-2 text-xs text-red-400">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{detectError}</span>
              </div>
            )}
            {suggestion && suggestion.empty && (
              <div
                className="flex items-start gap-2 text-xs text-gray-400"
                data-testid="preview-suggestion-empty"
              >
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>No recognised stack found in this checkout.</span>
                <button
                  type="button"
                  onClick={dismissSuggestion}
                  className="ml-auto text-gray-500 hover:text-gray-300"
                >
                  Dismiss
                </button>
              </div>
            )}
            {suggestion && !suggestion.empty && (
              <div
                className="border border-sky-500/30 bg-sky-500/5 rounded-lg p-3 space-y-2"
                data-testid="preview-suggestion"
              >
                <p className="text-xs text-sky-300">
                  Detected <strong>{suggestion.stack}</strong> — suggested defaults:
                </p>
                <ul className="text-xs font-mono text-gray-300 space-y-0.5 pl-3">
                  <li>startScript: {suggestion.startScript}</li>
                  <li>idleTTL: {suggestion.idleTTL}s</li>
                  <li>captureRoutes: {(suggestion.captureRoutes || []).join(', ') || '—'}</li>
                  <li className="text-gray-500">
                    (port {suggestion.port} from package.json convention — note: worktree previews
                    ignore per-project port overrides)
                  </li>
                </ul>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={acceptSuggestion}
                    className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 rounded-lg"
                    data-testid="preview-suggestion-accept"
                  >
                    <CheckCircle2 size={12} /> Accept
                  </button>
                  <button
                    type="button"
                    onClick={dismissSuggestion}
                    className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
                  >
                    <X size={12} /> Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Test result panel — appears above the save bar */}
          {(testPhase || testResult) && (
            <div
              className={`border rounded-xl p-4 space-y-3 ${
                testPhase === 'ready'
                  ? 'border-green-500/30 bg-green-500/5'
                  : testPhase === 'failed'
                    ? 'border-red-500/30 bg-red-500/5'
                    : 'border-gray-800 bg-gray-800/40'
              }`}
              data-testid="preview-test-panel"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {testPhase === 'starting' && (
                    <p
                      className="flex items-center gap-2 text-sm text-sky-300"
                      data-testid="preview-test-status-starting"
                    >
                      <Loader2 size={14} className="animate-spin" /> Starting…
                    </p>
                  )}
                  {testPhase === 'health' && (
                    <p
                      className="flex items-center gap-2 text-sm text-sky-300"
                      data-testid="preview-test-status-health"
                    >
                      <Loader2 size={14} className="animate-spin" /> Health check…
                    </p>
                  )}
                  {testPhase === 'ready' && testResult && (
                    <div className="space-y-2" data-testid="preview-test-status-ready">
                      <p className="flex items-center gap-2 text-sm text-green-400">
                        <CheckCircle2 size={14} /> Ready (
                        {Math.round((testResult.durationMs || 0) / 100) / 10}s, port{' '}
                        <code className="text-gray-300">{testResult.ports?.allocated ?? '—'}</code>)
                      </p>
                      {testResult.screenshotUrl && (
                        <a
                          href={testResult.screenshotUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-block"
                          data-testid="preview-test-screenshot-link"
                        >
                          <img
                            src={testResult.screenshotUrl}
                            alt="Preview screenshot"
                            className="rounded-lg border border-gray-700 max-w-md max-h-64 object-cover"
                            data-testid="preview-test-screenshot"
                          />
                        </a>
                      )}
                      {testResult.ports?.allocated && (
                        <p className="text-xs text-gray-500 flex items-center gap-1">
                          <ExternalLink size={12} />
                          <a
                            href={`http://localhost:${testResult.ports.allocated}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:underline"
                            data-testid="preview-test-live-link"
                          >
                            View live
                          </a>
                          <span className="text-gray-600">
                            — link is informational; the runtime is already torn down.
                          </span>
                        </p>
                      )}
                      {testResult.error && (
                        <p className="text-xs text-amber-400">Note: {testResult.error}</p>
                      )}
                    </div>
                  )}
                  {testPhase === 'failed' && testResult && (
                    <div className="space-y-1" data-testid="preview-test-status-failed">
                      <p className="flex items-center gap-2 text-sm text-red-400">
                        <AlertCircle size={14} /> Failed
                      </p>
                      <p
                        className="text-xs text-red-300 break-words"
                        data-testid="preview-test-error"
                      >
                        {testResult.error || 'Unknown error'}
                      </p>
                      {testResult.ports?.allocated && (
                        <p className="text-xs text-gray-500">
                          Allocated port: {testResult.ports.allocated}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {!isTesting && (
                  <button
                    type="button"
                    onClick={clearTestResult}
                    aria-label="Dismiss test result"
                    className="text-gray-500 hover:text-gray-300 shrink-0"
                    data-testid="preview-test-dismiss"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Save bar */}
          <div className="flex items-center gap-3 sticky bottom-0 bg-gray-950/80 backdrop-blur py-3 border-t border-gray-800">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
              data-testid="preview-save-button"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={!form.enabled || dirty || isTesting || saving}
              title={
                dirty
                  ? 'Save your changes before running a test'
                  : !form.enabled
                    ? 'Enable preview before running a test'
                    : 'Run a one-shot preview validation'
              }
              className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
              data-testid="preview-test-button"
            >
              {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {isTesting ? 'Testing…' : 'Test preview'}
            </button>
            <button
              type="button"
              onClick={handleAISetup}
              disabled={wizardStarting || saving}
              title="Open an AI-assisted setup wizard that walks you through preview configuration"
              className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
              data-testid="preview-ai-setup-button"
            >
              {wizardStarting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {wizardStarting ? 'Starting…' : 'AI Setup'}
            </button>
            {wizardError && (
              <span
                className="flex items-center gap-1 text-xs text-red-400"
                data-testid="preview-ai-setup-error"
              >
                <AlertCircle size={14} /> {wizardError}
              </span>
            )}
            {dirty && !saving && <span className="text-xs text-amber-400">Unsaved changes</span>}
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <CheckCircle2 size={14} /> Saved
              </span>
            )}
            {saveError && (
              <span className="flex items-center gap-1 text-xs text-red-400">
                <AlertCircle size={14} /> {saveError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Exported for tests.
export { buildPatchPayload, formFromProject, shallowEqualForm };
