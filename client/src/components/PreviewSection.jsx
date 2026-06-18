import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Monitor,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  Plus,
  Hammer,
  BookOpen,
  Key,
  Sparkles,
  Layers,
  ClipboardList,
  Square,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { envRowsFromDraftAndSecrets, isReservedEnvKey } from '../utils/projectEnvRows.js';

const PREVIEW_IDLE_TTL_MIN = 60;
const PREVIEW_IDLE_TTL_MAX = 86400;
const PREVIEW_MAX_ROUTES = 10;
const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_COMPOSE_ENTRY_PORT = 3000;
const COMPOSE_SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const COMPOSE_PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
// Mirror the server's bounds in `server/routes/projects.ts`
// (PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS / _MAX_MS). Kept in sync with the
// note in `formFromProject` — empty = use server default (10 min today).
const PREVIEW_READY_TIMEOUT_MIN_MS = 5_000;
const PREVIEW_READY_TIMEOUT_MAX_MS = 1_800_000;

const DEFAULT_FORM = Object.freeze({
  composeFile: DEFAULT_COMPOSE_FILE,
  composeEntryService: '',
  composeEntryPort: DEFAULT_COMPOSE_ENTRY_PORT,
  composeEnvFile: '',
  composeServices: [],
  healthPath: '/',
  idleTTL: 600,
  captureRoutes: ['/'],
  composeYaml: '',
  // Empty string = leave the server default in place. We only persist the
  // field when the user types a value, so the form does not silently
  // overwrite a previously saved override.
  composeReadyTimeoutMs: '',
});

export function isPreviewConfigured(project) {
  const compose = project?.prEnv?.preview?.compose;
  return !!(
    project?.prEnv?.preview?.enabled &&
    compose?.entryService &&
    typeof compose.entryPort === 'number' &&
    Number.isFinite(compose.entryPort)
  );
}

export function formFromProject(project) {
  if (!project) return { ...DEFAULT_FORM };
  const preview = project.prEnv?.preview || {};
  const compose = preview.compose || {};
  return {
    composeFile: compose.file || DEFAULT_FORM.composeFile,
    composeEntryService: compose.entryService || '',
    composeEntryPort:
      typeof compose.entryPort === 'number' && Number.isFinite(compose.entryPort)
        ? compose.entryPort
        : DEFAULT_FORM.composeEntryPort,
    composeEnvFile: compose.envFile || '',
    composeServices: [],
    healthPath: compose.healthPath || project.prEnv?.healthPath || '/',
    idleTTL:
      typeof preview.idleTTL === 'number' && Number.isFinite(preview.idleTTL)
        ? preview.idleTTL
        : DEFAULT_FORM.idleTTL,
    captureRoutes:
      Array.isArray(preview.captureRoutes) && preview.captureRoutes.length > 0
        ? [...preview.captureRoutes]
        : [...DEFAULT_FORM.captureRoutes],
    composeYaml: '',
    // Stored as a string for the controlled <input type="number">; empty
    // string means "no override, use the server default".
    composeReadyTimeoutMs:
      typeof compose.readyTimeoutMs === 'number' && Number.isFinite(compose.readyTimeoutMs)
        ? String(compose.readyTimeoutMs)
        : '',
  };
}

export function mergeDraftIntoForm(form, draft) {
  if (!draft) return { ...form };
  const next = { ...form };
  if (draft.phase === 'bootstrap_compose' && draft.bootstrap) {
    next.composeYaml = draft.bootstrap.composeYaml || next.composeYaml;
    next.composeFile = draft.bootstrap.file || next.composeFile;
    next.composeEntryService = draft.bootstrap.entryService || next.composeEntryService;
    next.composeEntryPort = draft.bootstrap.entryPort ?? next.composeEntryPort;
    next.composeServices = draft.bootstrap.services ? [...draft.bootstrap.services] : [];
  }
  if (draft.detected?.compose) {
    const c = draft.detected.compose;
    next.composeFile = c.file || next.composeFile;
    next.composeEntryService = c.entryService || next.composeEntryService;
    next.composeEntryPort = c.entryPort ?? next.composeEntryPort;
    next.composeServices = c.services ? [...c.services] : next.composeServices;
    if (c.envFile) next.composeEnvFile = c.envFile;
    if (c.healthPath) next.healthPath = c.healthPath;
    next.idleTTL = draft.detected.idleTTL ?? next.idleTTL;
    if (draft.detected.captureRoutes?.length) {
      next.captureRoutes = [...draft.detected.captureRoutes];
    }
  }
  const primary = draft.composeCandidates?.[0];
  if (primary?.services?.length && !next.composeServices.length) {
    next.composeServices = primary.services.map((s) => s.name);
  }
  if (!next.composeEntryService && draft.detected?.compose?.entryService) {
    next.composeEntryService = draft.detected.compose.entryService;
  }
  if (
    !next.composeEntryService &&
    primary?.services?.find((s) => s.name === primary.suggestedEntryService)?.name
  ) {
    next.composeEntryService = primary.suggestedEntryService;
  }
  return next;
}

export { envRowsFromDraftAndSecrets };

export function validateComposeForm(form) {
  const entryService = (form.composeEntryService || '').trim();
  if (!entryService) {
    return {
      field: 'composeEntryService',
      error: 'Select an entry service before building.',
    };
  }
  if (!COMPOSE_SERVICE_NAME_RE.test(entryService)) {
    return {
      field: 'composeEntryService',
      error:
        'Entry service must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (Docker compose service-name rule).',
    };
  }
  const composeFile = (form.composeFile || '').trim();
  if (composeFile) {
    if (composeFile.startsWith('/')) {
      return { field: 'composeFile', error: 'Compose file must be relative to the project root.' };
    }
    if (COMPOSE_PATH_TRAVERSAL_RE.test(composeFile)) {
      return { field: 'composeFile', error: 'Compose file must not contain `..` segments.' };
    }
  }
  return null;
}

export function buildBuildPayload(form, envRows, { needsBootstrap }) {
  const routes = (form.captureRoutes || [])
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter(Boolean);
  const payload = {
    compose: {
      file: (form.composeFile || DEFAULT_COMPOSE_FILE).trim(),
      entryService: (form.composeEntryService || '').trim(),
      entryPort: Number(form.composeEntryPort),
      healthPath: (form.healthPath || '/').trim() || '/',
    },
    captureRoutes: routes.length > 0 ? routes : ['/'],
    idleTTL: Number(form.idleTTL),
    envVars: (envRows || [])
      .filter((r) => r.key?.trim())
      // Reserved keys (AGENT_HUB_*, NODE_*, PATH, HOME) are server-injected
      // and the secrets store rejects them with a 400 that fails the whole
      // build. Drop them here so "Build and run" can never trip on one.
      .filter((r) => !isReservedEnvKey(r.key.trim()))
      .map((r) => ({
        key: r.key.trim(),
        value: r.value ?? '',
        kind: r.kind === 'plain' ? 'plain' : 'secret',
      })),
  };
  const envFile = (form.composeEnvFile || '').trim();
  if (envFile) payload.compose.envFile = envFile;
  // Only forward readyTimeoutMs when the user actually typed a value. An
  // empty input means "use the server default" — sending a zero / NaN
  // would trip the 5,000–1,800,000 ms bound check downstream.
  const readyTimeoutRaw =
    typeof form.composeReadyTimeoutMs === 'string'
      ? form.composeReadyTimeoutMs.trim()
      : form.composeReadyTimeoutMs;
  if (readyTimeoutRaw !== '' && readyTimeoutRaw !== undefined && readyTimeoutRaw !== null) {
    const parsed = Number(readyTimeoutRaw);
    if (Number.isFinite(parsed)) {
      payload.compose.readyTimeoutMs = Math.trunc(parsed);
    }
  }
  if (needsBootstrap && form.composeYaml?.trim()) {
    payload.composeYaml = form.composeYaml.trim();
  }
  return payload;
}

function PreviewBuildLog({ logTail }) {
  if (!logTail?.length) return null;
  return (
    <details className="mt-2" data-testid="preview-build-log">
      <summary className="text-xs text-gray-400 cursor-pointer select-none hover:text-gray-200">
        Compose logs ({logTail.length} lines)
      </summary>
      <pre className="mt-1 text-[11px] font-mono bg-gray-900/80 border border-gray-800 rounded-lg p-2 max-h-64 overflow-auto whitespace-pre-wrap text-gray-300">
        {logTail.join('\n')}
      </pre>
    </details>
  );
}

const CHECKLIST_STATUS_META = {
  pass: { label: 'Pass', className: 'text-emerald-400 border-emerald-900/50 bg-emerald-950/30' },
  warn: { label: 'Warn', className: 'text-amber-400 border-amber-900/50 bg-amber-950/30' },
  fail: { label: 'Fail', className: 'text-red-400 border-red-900/50 bg-red-950/30' },
};

function ComposePreviewChecklist({ items }) {
  if (!items?.length) return null;
  const failCount = items.filter((i) => i.status === 'fail').length;
  const warnCount = items.filter((i) => i.status === 'warn').length;
  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
      data-testid="preview-compose-checklist"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2">
          <ClipboardList size={14} className="text-sky-400" />
          Compose preview checklist
        </h4>
        {failCount > 0 && (
          <span className="text-xs text-red-400">
            {failCount} fail{failCount === 1 ? '' : 's'}
          </span>
        )}
        {warnCount > 0 && (
          <span className="text-xs text-amber-400">
            {warnCount} warn{warnCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500">
        Agent Hub runs compose from the session worktree and allocates a host port per preview. Fix
        failures before build; the guided walkthrough covers the same list.
      </p>
      <ul className="space-y-2">
        {items.map((item) => {
          const meta = CHECKLIST_STATUS_META[item.status] ?? CHECKLIST_STATUS_META.warn;
          return (
            <li
              key={item.id}
              className="rounded border border-gray-800/80 bg-gray-950/40 px-3 py-2 space-y-1"
              data-testid={`preview-checklist-${item.id}`}
            >
              <div className="flex flex-wrap items-start gap-2">
                <span
                  className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border shrink-0 ${meta.className}`}
                >
                  {meta.label}
                </span>
                <span className="text-[10px] text-gray-500 uppercase">{item.category}</span>
                <span className="text-sm text-gray-200 flex-1 min-w-0">{item.title}</span>
              </div>
              <p className="text-xs text-gray-400 pl-0.5">{item.description}</p>
              {item.hint && <p className="text-xs text-gray-500 italic pl-0.5">{item.hint}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const PREVIEW_STATUS_CLASS = {
  ready: 'text-emerald-400 border-emerald-900/50 bg-emerald-950/30',
  starting: 'text-sky-300 border-sky-900/50 bg-sky-950/30',
  failed: 'text-red-400 border-red-900/50 bg-red-950/30',
};

function RunningPreviewsPanel({ projectId, onOpenSession }) {
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [purging, setPurging] = useState(false);
  const [stoppingId, setStoppingId] = useState(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getProjectPreviews(projectId);
      setPreviews(Array.isArray(res?.previews) ? res.previews : []);
    } catch (err) {
      setError(err?.message || 'Failed to load running previews');
      setPreviews([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handlePurgeAll = async () => {
    if (!projectId || purging || previews.length === 0) return;
    if (
      !window.confirm(
        `Stop all ${previews.length} preview stack(s) for this project? Docker containers and volumes will be torn down.`,
      )
    ) {
      return;
    }
    setPurging(true);
    setError(null);
    try {
      const res = await api.purgeAllProjectPreviews(projectId);
      if (res?.failed?.length) {
        setError(
          `Stopped ${res.stopped ?? 0}; ${res.failed.length} failed: ${res.failed.map((f) => f.error).join('; ')}`,
        );
      }
      await reload();
    } catch (err) {
      setError(err?.message || 'Failed to purge previews');
    } finally {
      setPurging(false);
    }
  };

  const handleStopOne = async (previewId) => {
    if (!projectId || stoppingId) return;
    setStoppingId(previewId);
    setError(null);
    try {
      await api.stopPreview(projectId, previewId);
      await reload();
    } catch (err) {
      setError(err?.message || 'Failed to stop preview');
    } finally {
      setStoppingId(null);
    }
  };

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
      data-testid="preview-running-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-200">Running previews</h4>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || purging}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
          data-testid="preview-running-refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void handlePurgeAll()}
          disabled={purging || loading || previews.length === 0}
          className="ml-auto flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-50"
          data-testid="preview-purge-all-button"
        >
          {purging ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          Purge all
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Session preview stacks started from chat (compose or legacy spawn). Purge stops Docker
        compose projects and frees ports.
      </p>
      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={12} /> {error}
        </p>
      )}
      {loading && previews.length === 0 && (
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </p>
      )}
      {!loading && previews.length === 0 && (
        <p className="text-xs text-gray-500" data-testid="preview-running-empty">
          No active preview stacks for this project.
        </p>
      )}
      {previews.length > 0 && (
        <ul className="space-y-2">
          {previews.map((p) => {
            const statusClass = PREVIEW_STATUS_CLASS[p.status] ?? PREVIEW_STATUS_CLASS.starting;
            return (
              <li
                key={p.id}
                className="rounded border border-gray-800/80 bg-gray-950/40 px-3 py-2 flex flex-wrap items-start gap-2"
                data-testid={`preview-running-row-${p.id}`}
              >
                <span
                  className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border shrink-0 ${statusClass}`}
                >
                  {p.status}
                </span>
                <span className="text-[10px] text-gray-500 uppercase shrink-0">{p.kind}</span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <p className="text-sm text-gray-200 truncate">{p.sessionName || p.sessionId}</p>
                  <p className="text-[11px] text-gray-500 font-mono truncate">
                    {p.composeProjectName || p.id}
                    {typeof p.port === 'number' ? ` · port ${p.port}` : ''}
                    {p.url ? ` · ${p.url}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {typeof onOpenSession === 'function' && p.sessionId && (
                    <button
                      type="button"
                      onClick={() => onOpenSession({ sessionId: p.sessionId })}
                      className="text-xs text-sky-400 hover:text-sky-300 px-2 py-1 rounded border border-gray-700"
                    >
                      Open session
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleStopOne(p.id)}
                    disabled={stoppingId === p.id || purging}
                    className="flex items-center gap-1 text-xs text-gray-300 hover:text-white px-2 py-1 rounded border border-gray-700 disabled:opacity-50"
                    data-testid={`preview-stop-${p.id}`}
                  >
                    {stoppingId === p.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Square size={12} />
                    )}
                    Stop
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ScanSummary({ draft }) {
  if (!draft) return null;
  const services =
    draft.detected?.compose?.services ??
    draft.composeCandidates?.flatMap((c) => c.services.map((s) => `${c.file}: ${s.name}`)) ??
    [];
  return (
    <section
      className="rounded-lg border border-violet-900/40 bg-violet-950/20 p-4 space-y-2"
      data-testid="preview-scan-summary"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-200">
        {draft.isMonorepo && (
          <span className="inline-flex items-center gap-1 text-xs bg-violet-900/50 text-violet-200 px-2 py-0.5 rounded">
            <Layers size={12} /> Monorepo
          </span>
        )}
        <span className="text-xs text-gray-400">
          {draft.phase === 'bootstrap_compose'
            ? 'No compose file — will generate'
            : 'Compose detected'}
        </span>
        <span className="text-xs text-gray-500">
          · {draft.envVars?.length ?? 0} env vars · {draft.composeCandidates?.length ?? 0} compose
          file(s)
        </span>
      </div>
      {services.length > 0 && (
        <p className="text-xs text-gray-400">
          Services:{' '}
          <span className="text-gray-300 font-mono">
            {Array.isArray(draft.detected?.compose?.services)
              ? draft.detected.compose.services.join(', ')
              : services.slice(0, 12).join(' · ')}
          </span>
        </p>
      )}
      {draft.readme?.setupExcerpt && (
        <p className="text-xs text-gray-500 line-clamp-3">{draft.readme.setupExcerpt}</p>
      )}
    </section>
  );
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
  const [draft, setDraft] = useState(null);
  const [envRows, setEnvRows] = useState([]);
  const [routeDraft, setRouteDraft] = useState('');
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const [buildPhase, setBuildPhase] = useState(null);
  const [buildResult, setBuildResult] = useState(null);
  const [buildError, setBuildError] = useState(null);
  const [setupStarted, setSetupStarted] = useState(false);
  const buildStatusRef = useRef(null);

  const configured = isPreviewConfigured(project);
  const showSetupForm = setupStarted || configured;
  const needsBootstrap = draft?.phase === 'bootstrap_compose';

  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const reloadDraft = useCallback(async (pid) => {
    if (!pid) return;
    setLoadingDraft(true);
    setDraftError(null);
    try {
      const [draftRes, secretsRes] = await Promise.all([
        api.getPreviewEnvironmentDraft(pid),
        api.getProjectSecrets(pid).catch(() => ({ secrets: [] })),
      ]);
      const d = draftRes?.draft || null;
      setDraft(d);
      const found = projectsRef.current.find((p) => p.id === pid);
      setForm(mergeDraftIntoForm(formFromProject(found), d));
      setEnvRows(envRowsFromDraftAndSecrets(d, secretsRes?.secrets || []));
    } catch (err) {
      setDraftError(err?.message || 'Failed to scan project');
    } finally {
      setLoadingDraft(false);
    }
  }, []);

  useEffect(() => {
    const found = projects?.find((p) => p.id === projectId) || null;
    setProject(found);
    setForm(formFromProject(found));
    setBuildPhase(null);
    setBuildResult(null);
    setBuildError(null);
    setWizardError(null);
  }, [projectId, projects]);

  // Open the editable form when the project already has saved preview config.
  useEffect(() => {
    const found = projects?.find((p) => p.id === projectId) || null;
    if (isPreviewConfigured(found)) setSetupStarted(true);
  }, [projectId, projects]);

  useEffect(() => {
    if (projectId) void reloadDraft(projectId);
  }, [projectId, reloadDraft]);

  const handleStartSetup = () => {
    if (!projectId) return;
    setSetupStarted(true);
    setBuildError(null);
    void reloadDraft(projectId);
  };

  useEffect(() => {
    if (!projects?.length) return;
    if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    const handler = (e) => {
      const pid = e?.detail?.projectId;
      if (pid && project?.id === pid) {
        setSetupStarted(true);
        if (typeof onProjectsChange === 'function') onProjectsChange();
      }
    };
    window.addEventListener('agenthub:preview_wizard_complete', handler);
    return () => window.removeEventListener('agenthub:preview_wizard_complete', handler);
  }, [project?.id, onProjectsChange]);

  const handleStartWalkthrough = useCallback(async () => {
    if (!project || wizardStarting) return;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startPreviewWizard(project.id);
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
    } catch (err) {
      setWizardError(err?.message || 'Failed to start setup walkthrough');
    } finally {
      setWizardStarting(false);
    }
  }, [project, wizardStarting, onOpenSession]);

  useEffect(() => {
    if (typeof registerGuard !== 'function') return undefined;
    const guard = () => {
      if (buildPhase !== 'running') return true;
      return window.confirm('Preview build is in progress. Leave anyway?');
    };
    registerGuard(guard);
    return () => registerGuard(null);
  }, [registerGuard, buildPhase]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const updateEnvRow = (idx, patch) => {
    setEnvRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const addEnvRow = () =>
    setEnvRows((rows) => [...rows, { key: '', value: '', kind: 'secret', sources: [] }]);
  const removeEnvRow = (idx) => setEnvRows((rows) => rows.filter((_, i) => i !== idx));

  const handleBuild = async () => {
    if (!project || buildPhase === 'running') return;
    const composeErr = validateComposeForm(form);
    if (composeErr) {
      setBuildError(composeErr.error);
      setBuildPhase('failed');
      setBuildResult(null);
      return;
    }
    if (needsBootstrap && !form.composeYaml?.trim()) {
      setBuildError('Add compose YAML before building.');
      setBuildPhase('failed');
      setBuildResult(null);
      return;
    }
    setBuildPhase('running');
    setBuildError(null);
    setBuildResult(null);
    try {
      const result = await api.buildPreviewEnvironment(
        project.id,
        buildBuildPayload(form, envRows, { needsBootstrap }),
      );
      setBuildResult(result);
      setBuildPhase(result?.ok ? 'ready' : 'failed');
      if (!result?.ok) {
        setBuildError(result?.error || result?.steps?.previewTest?.error || 'Build failed');
      } else if (typeof onProjectsChange === 'function') {
        onProjectsChange();
      }
    } catch (err) {
      setBuildError(err?.message || 'Build failed');
      setBuildPhase('failed');
    }
  };

  useEffect(() => {
    if (!buildPhase) return;
    buildStatusRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [buildPhase, buildError, buildResult]);

  if (!projects?.length) {
    return <p className="text-sm text-gray-500">No projects yet.</p>;
  }

  return (
    <div className="space-y-6 pb-28">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Monitor size={18} className="text-sky-400" />
          Preview environment
        </h3>
        <p className="text-xs text-gray-500 max-w-2xl">
          Click <strong className="text-gray-300">Start setup</strong> to scan the repo and generate
          a draft compose config. Adjust services, ports, and env vars here, then{' '}
          <strong className="text-gray-300">Build and run</strong> to save and validate. Use the
          agent walkthrough if you want help choosing entry services in a monorepo.
        </p>
        <div className="flex items-center gap-2 text-sm mt-4">
          <button
            type="button"
            onClick={() => project?.id && reloadDraft(project.id)}
            disabled={loadingDraft || wizardStarting}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200"
            data-testid="preview-rescan-button"
          >
            <RefreshCw size={12} className={loadingDraft ? 'animate-spin' : ''} />
            Rescan
          </button>
        </div>
      </div>

      {projectId && <RunningPreviewsPanel projectId={projectId} onOpenSession={onOpenSession} />}

      {configured && (
        <p
          className="text-sm text-green-400 flex items-center gap-2"
          data-testid="preview-configured-banner"
        >
          <CheckCircle2 size={16} />
          Preview configured — entry{' '}
          <code className="text-gray-300">{project.prEnv.preview.compose.entryService}</code> on
          port {project.prEnv.preview.compose.entryPort}
        </p>
      )}

      {!showSetupForm && (
        <section
          className="rounded-lg border border-gray-800 bg-gray-900/40 p-6 text-center space-y-4"
          data-testid="preview-setup-start-card"
        >
          <p className="text-sm text-gray-300">
            {configured
              ? 'Adjust preview settings or rescan the repository.'
              : 'Scan README, compose files, and env vars to generate a starting configuration.'}
          </p>
          <button
            type="button"
            onClick={handleStartSetup}
            disabled={loadingDraft}
            className="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium px-6 py-2.5 rounded-lg"
            data-testid="preview-start-setup-button"
          >
            {loadingDraft ? <Loader2 size={16} className="animate-spin" /> : <Hammer size={16} />}
            {loadingDraft ? 'Scanning…' : configured ? 'Edit setup' : 'Start setup'}
          </button>
        </section>
      )}

      {showSetupForm && loadingDraft && (
        <p className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Scanning repository…
        </p>
      )}
      {draftError && (
        <p className="text-sm text-red-400 flex items-center gap-2">
          <AlertCircle size={14} /> {draftError}
        </p>
      )}
      {wizardError && (
        <p
          className="text-sm text-red-400 flex items-center gap-2"
          data-testid="preview-wizard-error"
        >
          <AlertCircle size={14} /> {wizardError}
        </p>
      )}

      {showSetupForm && (
        <>
          <ScanSummary draft={draft} />
          <ComposePreviewChecklist items={draft?.composeChecklist} />

          {draft?.readme?.setupExcerpt && (
            <section
              className="rounded-lg border border-gray-800 bg-gray-900/50 p-4"
              data-testid="preview-readme-hints"
            >
              <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2 mb-2">
                <BookOpen size={14} className="text-amber-400" />
                README ({draft.readme.readmePath})
              </h4>
              <pre className="text-xs text-gray-400 whitespace-pre-wrap font-mono">
                {draft.readme.setupExcerpt}
              </pre>
            </section>
          )}

          <section
            className="rounded-lg border border-gray-800 p-4 space-y-4"
            data-testid="preview-compose-section"
          >
            <h4 className="text-sm font-medium text-gray-200">Docker Compose</h4>
            {needsBootstrap && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Generated compose ({form.composeFile}) — edit before building
                </label>
                <textarea
                  value={form.composeYaml}
                  onChange={(e) => setField('composeYaml', e.target.value)}
                  rows={12}
                  className="w-full font-mono text-xs bg-gray-950 border border-gray-700 rounded-lg p-3 text-gray-200"
                  data-testid="preview-compose-yaml"
                />
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Compose file</label>
                <input
                  type="text"
                  value={form.composeFile}
                  onChange={(e) => setField('composeFile', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-compose-file"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Env file (optional)</label>
                <input
                  type="text"
                  value={form.composeEnvFile}
                  onChange={(e) => setField('composeEnvFile', e.target.value)}
                  placeholder={draft?.envExamplePath || '.env'}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-compose-env-file"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Entry service {draft?.isMonorepo ? '(browser / UI)' : ''}
                </label>
                <select
                  value={form.composeEntryService}
                  onChange={(e) => setField('composeEntryService', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-compose-entry-service"
                >
                  <option value="">Select service…</option>
                  {(form.composeServices?.length
                    ? form.composeServices
                    : draft?.detected?.compose?.services || ['web']
                  ).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Entry port</label>
                <input
                  type="number"
                  value={form.composeEntryPort}
                  onChange={(e) => setField('composeEntryPort', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-compose-entry-port"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Health path</label>
                <input
                  type="text"
                  value={form.healthPath}
                  onChange={(e) => setField('healthPath', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-health-path"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Idle TTL (seconds)</label>
                <input
                  type="number"
                  min={PREVIEW_IDLE_TTL_MIN}
                  max={PREVIEW_IDLE_TTL_MAX}
                  value={form.idleTTL}
                  onChange={(e) => setField('idleTTL', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-idle-ttl"
                />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="preview-ready-timeout" className="block text-xs text-gray-400 mb-1">
                  Ready timeout (ms){' '}
                  <span className="text-gray-500">
                    — leave blank for the server default (10 min)
                  </span>
                </label>
                <input
                  id="preview-ready-timeout"
                  type="number"
                  min={PREVIEW_READY_TIMEOUT_MIN_MS}
                  max={PREVIEW_READY_TIMEOUT_MAX_MS}
                  step={1000}
                  placeholder="e.g. 1800000 for 30 min"
                  value={form.composeReadyTimeoutMs}
                  onChange={(e) => setField('composeReadyTimeoutMs', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                  data-testid="preview-ready-timeout"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  How long Agent Hub waits for the entry service to report healthy after compose
                  starts. Raise this when your boot sequence (DB restore, asset build, framework
                  compile) needs more than 10 minutes. Bounds: {PREVIEW_READY_TIMEOUT_MIN_MS}–
                  {PREVIEW_READY_TIMEOUT_MAX_MS} ms (5 s – 30 min).
                </p>
              </div>
            </div>
          </section>

          <section
            className="rounded-lg border border-gray-800 p-4 space-y-3"
            data-testid="preview-env-section"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                <Key size={14} className="text-violet-400" />
                Environment variables
              </h4>
              <button
                type="button"
                onClick={addEnvRow}
                className="text-xs text-sky-400 hover:text-sky-300"
                data-testid="preview-env-add"
              >
                Add variable
              </button>
            </div>
            <div className="space-y-2">
              {envRows.map((row, idx) => (
                <div key={`${row.key}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateEnvRow(idx, { key: e.target.value })}
                    className="col-span-3 font-mono text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5"
                  />
                  <input
                    type={row.kind === 'secret' ? 'password' : 'text'}
                    value={row.value}
                    onChange={(e) => updateEnvRow(idx, { value: e.target.value })}
                    placeholder={
                      row.hadSecret && row.kind === 'secret' ? '(unchanged if empty)' : 'value'
                    }
                    className="col-span-6 font-mono text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5"
                  />
                  <select
                    value={row.kind}
                    onChange={(e) => updateEnvRow(idx, { kind: e.target.value })}
                    className="col-span-2 text-xs bg-gray-900 border border-gray-700 rounded px-1 py-1.5"
                  >
                    <option value="secret">secret</option>
                    <option value="plain">plain</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeEnvRow(idx)}
                    className="col-span-1 text-gray-500 hover:text-red-400"
                    aria-label="Remove"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {(buildPhase === 'running' || buildResult || buildError) && (
            <section
              ref={buildStatusRef}
              className={`rounded-lg border p-4 ${
                buildPhase === 'ready'
                  ? 'border-green-800 bg-green-950/30'
                  : buildPhase === 'running'
                    ? 'border-sky-800/60 bg-sky-950/20'
                    : 'border-red-900/60 bg-red-950/20'
              }`}
              data-testid="preview-build-status"
            >
              {buildPhase === 'running' && (
                <p className="text-sm text-sky-300 flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Saving config and starting compose (this can take 1–3 minutes on first boot)…
                </p>
              )}
              {buildPhase === 'ready' && (
                <div className="space-y-2">
                  <p className="text-sm text-green-400 flex items-center gap-2">
                    <CheckCircle2 size={16} /> Saved and validated.
                  </p>
                  {buildResult?.steps?.previewTest?.url && (
                    <p className="text-xs text-gray-400">
                      Health check passed at{' '}
                      <a
                        href={buildResult.steps.previewTest.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline font-mono"
                      >
                        {buildResult.steps.previewTest.url}
                      </a>
                      {typeof buildResult.steps.previewTest.durationMs === 'number' && (
                        <> ({(buildResult.steps.previewTest.durationMs / 1000).toFixed(1)}s)</>
                      )}
                      . The test container was stopped after validation — open a chat session and
                      ask the agent to start a preview to use the side pane.
                    </p>
                  )}
                </div>
              )}
              {(buildPhase === 'failed' || (buildError && buildPhase !== 'running')) && (
                <p className="text-sm text-red-400">{buildError}</p>
              )}
              <PreviewBuildLog logTail={buildResult?.steps?.previewTest?.logTail} />
            </section>
          )}

          <div className="fixed bottom-0 left-0 right-0 md:left-64 z-20 flex flex-col gap-2 px-6 py-4 bg-gray-950/95 border-t border-gray-800 backdrop-blur">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleBuild}
                disabled={buildPhase === 'running'}
                className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg"
                data-testid="preview-build-button"
              >
                {buildPhase === 'running' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Hammer size={16} />
                )}
                {buildPhase === 'running' ? 'Building…' : 'Build and run'}
              </button>
              <button
                type="button"
                onClick={handleStartWalkthrough}
                disabled={wizardStarting || loadingDraft}
                className="flex items-center gap-2 border border-violet-700 text-violet-200 hover:bg-violet-950/50 disabled:opacity-50 text-sm px-4 py-2.5 rounded-lg"
                data-testid="preview-walkthrough-button"
              >
                {wizardStarting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                Agent walkthrough
              </button>
            </div>
            {buildError && buildPhase === 'failed' && (
              <p className="text-xs text-red-400" data-testid="preview-build-error-inline">
                {buildError}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
