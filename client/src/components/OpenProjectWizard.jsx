import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getApiBase, getAuthHeaders, getConnectionConfig } from '../utils/connection.js';
import ServerBrowser from './ServerBrowser.jsx';
import PreviewConfirm, { buildPreviewPatch } from './PreviewConfirm.jsx';

export const NEW_PROJECT_WIZARD_DRAFT_KEY = 'agentHub:v1:newProjectWizardDraft';

const COLOR_PRESETS = [
  '#6366F1',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
  '#F59E0B',
  '#10B981',
  '#06B6D4',
  '#6B7280',
];

const CONTEXT_FILE_TABS = ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];

const STEP_LABELS = ['Select Folder', 'Analyze', 'GitHub', 'Review & Create'];

function deriveNameFromPath(path) {
  return path.split('/').filter(Boolean).pop() || '';
}

function deriveIdFromName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function Spinner({ size = 5 }) {
  return (
    <svg
      className={`animate-spin h-${size} w-${size} text-emerald-400`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function StepIndicator({ currentStep }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-6">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={`w-8 h-px ${isCompleted || isActive ? 'bg-emerald-500' : 'bg-gray-600'}`}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors ${
                  isCompleted
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : isActive
                      ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10'
                      : 'border-gray-600 text-gray-500 bg-transparent'
                }`}
              >
                {isCompleted ? (
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  stepNum
                )}
              </div>
              <span
                className={`text-xs font-medium ${
                  isActive ? 'text-emerald-400' : isCompleted ? 'text-emerald-500' : 'text-gray-500'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OpenProjectWizard({ onClose, onProjectCreated, layout = 'modal' }) {
  const [step, setStep] = useState(1);

  // Step 1 mode: 'local' or 'clone'
  const [sourceMode, setSourceMode] = useState('local');

  // Step 1 state (shared)
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [color, setColor] = useState(COLOR_PRESETS[0]);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);

  // Clone-specific state
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneTarget, setCloneTarget] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneLog, setCloneLog] = useState([]);
  const [cloneError, setCloneError] = useState(null);
  const [showTargetBrowser, setShowTargetBrowser] = useState(false);
  const cloneIdRef = useRef(null);

  // Step 2 state
  const [analyzing, setAnalyzing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [progressLog, setProgressLog] = useState([]); // recent activity messages
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);

  // Step 3 state — GitHub
  // ghStatus shape: { authenticated, user, scopes, source: 'gh-cli' | 'oauth' | 'pat' | null,
  //                   serverConfigured: boolean, error?: string }
  // `source` records which auth path the wizard accepted so the green pill can
  // label "via PAT" / "via OAuth" / "via gh CLI". `serverConfigured` mirrors
  // `/api/auth/github/status` and gates the "Sign in with GitHub" button.
  const [ghStatus, setGhStatus] = useState(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [repoInfo, setRepoInfo] = useState(null); // { hasRemote, owner, repo, url }
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [testResult, setTestResult] = useState(null); // { ok, repoInfo } or { ok: false, error }
  const [testing, setTesting] = useState(false);
  const [skipGitHub, setSkipGitHub] = useState(false);

  // Inline PAT entry — mirrors GithubConnectionSection.jsx so users without
  // shell access (the only case where `gh auth login` was unrunnable) can
  // authenticate without leaving the wizard.
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState(null);

  // Step 4 state
  const [selectedAgents, setSelectedAgents] = useState({});
  const [contextFiles, setContextFiles] = useState({});
  const [activeTab, setActiveTab] = useState('SOUL.md');
  const [creating, setCreating] = useState(false);

  // Preview-defaults confirmation state. `detectedPreview` is populated from
  // the `clone-preview-defaults` WebSocket event broadcast after the server
  // runs detect-preview-defaults.ts against the freshly-cloned worktree.
  //   null                 → event hasn't fired yet, or fired with detected:null
  //                          (unknown stack — silent empty path, no UI)
  //   { stack, ... }       → render the PreviewConfirm panel in Step 4
  // `previewDecision` captures the user's choice from the panel:
  //   null                          → not yet decided
  //   { enabled: false }            → user clicked Skip
  //   { enabled: true, ...form }    → user accepted or edited the defaults
  const [detectedPreview, setDetectedPreview] = useState(null);
  const [previewDecision, setPreviewDecision] = useState(null);

  const [showBrowser, setShowBrowser] = useState(false);

  const analyzeIdRef = useRef(null);
  const terminalRef = useRef(null);
  const hasRestoredDraftRef = useRef(false);

  // Determine if we're in remote mode (server browser needed)
  const isRemote = getConnectionConfig().mode === 'remote';
  const isElectronLocal = window.electronAPI?.isElectron && !isRemote;

  // Auto-derive name and id from path or clone URL
  useEffect(() => {
    if (!nameManuallyEdited) {
      const source =
        sourceMode === 'clone'
          ? cloneUrl
              .replace(/\.git$/, '')
              .split('/')
              .pop() || ''
          : deriveNameFromPath(path);
      setName(source);
      if (!idManuallyEdited) {
        setProjectId(deriveIdFromName(source));
      }
    }
  }, [path, cloneUrl, sourceMode, nameManuallyEdited, idManuallyEdited]);

  // Auto-derive id from name
  useEffect(() => {
    if (!idManuallyEdited) {
      setProjectId(deriveIdFromName(name));
    }
  }, [name, idManuallyEdited]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [progressText, cloneLog]);

  // WebSocket events for analysis
  useEffect(() => {
    const handler = (e) => {
      const data = e.detail;
      if (data.analyzeId !== analyzeIdRef.current) return;
      if (data.type === 'analyze-progress') {
        if (data.message) {
          setProgressLog((prev) => [...prev.slice(-19), data.message]);
        } else if (data.chunk || data.text) {
          setProgressText((prev) => prev + (data.chunk || data.text || ''));
        }
      }
      if (data.type === 'analyze-complete') {
        setAnalyzing(false);
        // Normalize: server prompt produces `suggestedAgents`; older code expected `agents`.
        const normalized = {
          ...data.result,
          agents: data.result?.agents || data.result?.suggestedAgents || [],
        };
        setAnalysisResult(normalized);
        // Initialize step 3 state from result
        if (normalized.agents.length) {
          const agentMap = {};
          normalized.agents.forEach((a, i) => {
            agentMap[i] = true;
          });
          setSelectedAgents(agentMap);
        }
        if (data.result?.contextFiles) {
          setContextFiles({ ...data.result.contextFiles });
        }
      }
      if (data.type === 'analyze-error') {
        setAnalyzing(false);
        setAnalysisError(data.error || 'Analysis failed.');
      }
    };
    window.addEventListener('analyze-ws', handler);
    return () => window.removeEventListener('analyze-ws', handler);
  }, []);

  // WebSocket events for clone
  useEffect(() => {
    const handler = (e) => {
      const data = e.detail;
      if (data.cloneId !== cloneIdRef.current) return;
      if (data.type === 'clone-progress') {
        setCloneLog((prev) => [...prev.slice(-29), data.message]);
      }
      if (data.type === 'clone-complete') {
        setCloning(false);
        setPath(data.path);
        // Auto-proceed to analyze after successful clone
        setCloneLog((prev) => [...prev, '✓ Clone complete! Starting analysis...']);
      }
      if (data.type === 'clone-error') {
        setCloning(false);
        setCloneError(data.error || 'Clone failed.');
      }
      if (data.type === 'clone-preview-defaults') {
        // server/routes/projects.ts emits this after the clone finishes and
        // detect-preview-defaults inspects package.json. `detected` is the
        // raw DetectedPreviewDefaults shape (stack, startScript, port,
        // captureRoutes, idleTTL) or null for unknown stacks.
        setDetectedPreview(data.detected || null);
        setPreviewDecision(null);
      }
    };
    window.addEventListener('clone-ws', handler);
    return () => window.removeEventListener('clone-ws', handler);
  }, []);

  const handleClone = useCallback(async () => {
    setCloning(true);
    setCloneLog([]);
    setCloneError(null);

    try {
      const res = await fetch(`${getApiBase()}/projects/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ url: cloneUrl, targetDir: cloneTarget || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 = directory already exists, offer to use it
        if (res.status === 409 && data.existingPath) {
          setCloning(false);
          setPath(data.existingPath);
          setCloneError(null);
          setCloneLog([
            `Repository already cloned at ${data.existingPath}. Using existing directory.`,
          ]);
          return;
        }
        throw new Error(data.error || `Clone request failed: ${res.status}`);
      }
      cloneIdRef.current = data.cloneId;
      setCloneLog(['Starting git clone...']);
    } catch (err) {
      setCloning(false);
      setCloneError(err.message);
    }
  }, [cloneUrl, cloneTarget]);

  const handleAnalyze = useCallback(async () => {
    setStep(2);
    setAnalyzing(true);
    setProgressText('');
    setProgressLog([]);
    setAnalysisResult(null);
    setAnalysisError(null);

    try {
      const res = await fetch(`${getApiBase()}/projects/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ cwd: path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Analysis request failed: ${res.status}`);
      }
      const { analyzeId } = await res.json();
      analyzeIdRef.current = analyzeId;
    } catch (err) {
      setAnalyzing(false);
      setAnalysisError(err.message);
    }
  }, [path]);

  const detectGitHub = useCallback(async () => {
    setGhLoading(true);
    setGhStatus(null);
    setRepoInfo(null);
    setTestResult(null);
    setTokenError(null);
    setOauthError(null);
    try {
      // Check both auth sources in parallel:
      //   /api/github/status       — host `gh` CLI (operator-level)
      //   /api/auth/github/status  — per-user OAuth or PAT (UI-managed)
      // The wizard treats the user as authenticated if EITHER reports
      // connected. `gh` CLI wins the source label only when no per-user
      // connection is present, since per-user auth is what we'd push the
      // user toward configuring next time.
      const [cliRes, userRes] = await Promise.all([
        fetch(`${getApiBase()}/github/status`, {
          headers: getAuthHeaders(),
        }).catch(() => null),
        fetch(`${getApiBase()}/auth/github/status`, {
          headers: getAuthHeaders(),
        }).catch(() => null),
      ]);

      let cliStatus = null;
      if (cliRes && cliRes.ok) {
        cliStatus = await cliRes.json().catch(() => null);
      }
      let userStatus = null;
      if (userRes && userRes.ok) {
        userStatus = await userRes.json().catch(() => null);
      }

      const userConnected = !!userStatus?.connected;
      const cliConnected = !!cliStatus?.authenticated;
      const serverConfigured = userStatus?.serverConfigured !== false;

      let merged;
      if (userConnected) {
        // Per-user connection takes precedence — that's the identity the
        // server actually uses for PR list / merge / comment actions.
        // The status endpoint does not currently distinguish OAuth from PAT
        // in its response, so we surface a single 'github' source label and
        // let downstream code refine if/when that field is added.
        merged = {
          authenticated: true,
          user: userStatus.login || cliStatus?.user || null,
          scopes: cliStatus?.scopes || [],
          source: 'github',
          serverConfigured,
        };
      } else if (cliConnected) {
        merged = {
          authenticated: true,
          user: cliStatus.user,
          scopes: cliStatus.scopes || [],
          source: 'gh-cli',
          serverConfigured,
        };
      } else {
        merged = {
          authenticated: false,
          user: null,
          scopes: [],
          source: null,
          serverConfigured,
          error: cliStatus?.error || userStatus?.error || 'Not authenticated with GitHub',
        };
      }
      setGhStatus(merged);

      // Detect repo from directory whenever we have any auth.
      if (merged.authenticated && path) {
        const repoRes = await fetch(`${getApiBase()}/github/detect-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ cwd: path }),
        });
        const repo = await repoRes.json();
        setRepoInfo(repo);
        if (repo.hasRemote && repo.owner && repo.repo) {
          setRepoOwner(repo.owner);
          setRepoName(repo.repo);
        }
      }
    } catch {
      setGhStatus({
        authenticated: false,
        user: null,
        scopes: [],
        source: null,
        serverConfigured: true,
        error: 'Failed to check GitHub status',
      });
    } finally {
      setGhLoading(false);
    }
  }, [path]);

  const handleStartOAuth = useCallback(async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const res = await fetch(
        `${getApiBase()}/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
        { headers: getAuthHeaders() },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.code === 'github_oauth_not_configured') {
          // Pivot to PAT path automatically — the user can still sign in
          // without OAuth credentials being configured on the server.
          setShowTokenInput(true);
          throw new Error(
            'GitHub OAuth is not configured on this server. Use a personal access token instead.',
          );
        }
        throw new Error(body.error || `GET /auth/github/start → ${res.status}`);
      }
      const body = await res.json();
      window.location.href = body.authorizeUrl;
    } catch (err) {
      setOauthError(err.message || String(err));
    } finally {
      setOauthBusy(false);
    }
  }, []);

  const handleSaveToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setTokenSaving(true);
    setTokenError(null);
    try {
      const res = await fetch(`${getApiBase()}/auth/github/connect-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `POST /auth/github/connect-token → ${res.status}`);
      }
      setTokenInput('');
      setShowTokenInput(false);
      // Re-run detection so the green pill picks up the new connection.
      await detectGitHub();
    } catch (err) {
      setTokenError(err.message || String(err));
    } finally {
      setTokenSaving(false);
    }
  }, [tokenInput, detectGitHub]);

  const testGitHubConnection = useCallback(async () => {
    if (!repoOwner || !repoName) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${getApiBase()}/github/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ owner: repoOwner, repo: repoName }),
      });
      const result = await res.json();
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: 'Request failed' });
    } finally {
      setTesting(false);
    }
  }, [repoOwner, repoName]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const agents = (analysisResult?.agents || []).filter((_, i) => selectedAgents[i]);
      // Include GitHub config if user set it up
      const githubConfig =
        !skipGitHub && repoOwner && repoName
          ? { githubRepo: { owner: repoOwner, repo: repoName } }
          : {};
      const res = await fetch(`${getApiBase()}/projects/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          project: { id: projectId, name, cwd: path, color, ...githubConfig },
          agents,
          contextFiles,
          commands: analysisResult?.commands || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Create failed: ${res.status}`);
      }
      const project = await res.json();

      // If the user accepted / edited / skipped the detected preview config,
      // persist that choice to the new project via the PATCH route. Onboard
      // doesn't accept `prEnv` directly, so a separate call is required.
      // Failures here are non-fatal — the project itself is already created;
      // the user can edit the preview config from settings.
      if (previewDecision) {
        const patch = buildPreviewPatch(previewDecision);
        if (patch) {
          try {
            await fetch(`${getApiBase()}/projects/${project.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
              body: JSON.stringify(patch),
            });
          } catch {
            /* best-effort */
          }
        }
      }

      try {
        sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
      } catch {
        /* ignore */
      }
      onProjectCreated(project);
      onClose();
    } catch (err) {
      setAnalysisError(err.message);
    } finally {
      setCreating(false);
    }
  }, [
    analysisResult,
    selectedAgents,
    contextFiles,
    projectId,
    name,
    path,
    color,
    skipGitHub,
    repoOwner,
    repoName,
    previewDecision,
    onProjectCreated,
    onClose,
  ]);

  const isFullscreen = layout === 'fullscreen';

  const persistDraftSync = useCallback(() => {
    try {
      sessionStorage.setItem(
        NEW_PROJECT_WIZARD_DRAFT_KEY,
        JSON.stringify({
          v: 1,
          step,
          sourceMode,
          path,
          name,
          projectId,
          color,
          nameManuallyEdited,
          idManuallyEdited,
          cloneUrl,
          cloneTarget,
          skipGitHub,
          repoOwner,
          repoName,
          selectedAgents,
          contextFiles,
          activeTab,
          analysisResult,
          ghStatus,
          repoInfo,
          testResult,
          progressText,
          progressLog,
          cloneLog,
          detectedPreview,
          previewDecision,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    step,
    sourceMode,
    path,
    name,
    projectId,
    color,
    nameManuallyEdited,
    idManuallyEdited,
    cloneUrl,
    cloneTarget,
    skipGitHub,
    repoOwner,
    repoName,
    selectedAgents,
    contextFiles,
    activeTab,
    analysisResult,
    ghStatus,
    repoInfo,
    testResult,
    progressText,
    progressLog,
    cloneLog,
    detectedPreview,
    previewDecision,
  ]);

  const handleRequestClose = useCallback(() => {
    persistDraftSync();
    onClose();
  }, [persistDraftSync, onClose]);

  // Restore draft once (e.g. user left the wizard and re-opened it).
  useEffect(() => {
    if (hasRestoredDraftRef.current) return;
    hasRestoredDraftRef.current = true;
    try {
      const raw = sessionStorage.getItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.v !== 1) return;
      let nextStep = typeof d.step === 'number' ? d.step : 1;
      if (nextStep >= 2 && !d.analysisResult) nextStep = 1;
      setStep(nextStep);
      if (d.sourceMode === 'local' || d.sourceMode === 'clone') setSourceMode(d.sourceMode);
      if (typeof d.nameManuallyEdited === 'boolean') setNameManuallyEdited(d.nameManuallyEdited);
      if (typeof d.idManuallyEdited === 'boolean') setIdManuallyEdited(d.idManuallyEdited);
      if (typeof d.path === 'string') setPath(d.path);
      if (typeof d.name === 'string') setName(d.name);
      if (typeof d.projectId === 'string') setProjectId(d.projectId);
      if (typeof d.color === 'string') setColor(d.color);
      if (typeof d.cloneUrl === 'string') setCloneUrl(d.cloneUrl);
      if (typeof d.cloneTarget === 'string') setCloneTarget(d.cloneTarget);
      if (typeof d.skipGitHub === 'boolean') setSkipGitHub(d.skipGitHub);
      if (typeof d.repoOwner === 'string') setRepoOwner(d.repoOwner);
      if (typeof d.repoName === 'string') setRepoName(d.repoName);
      if (d.selectedAgents && typeof d.selectedAgents === 'object')
        setSelectedAgents(d.selectedAgents);
      if (d.contextFiles && typeof d.contextFiles === 'object') setContextFiles(d.contextFiles);
      if (typeof d.activeTab === 'string') setActiveTab(d.activeTab);
      if (d.analysisResult) setAnalysisResult(d.analysisResult);
      if (d.ghStatus) setGhStatus(d.ghStatus);
      if (d.repoInfo) setRepoInfo(d.repoInfo);
      if (d.testResult) setTestResult(d.testResult);
      if (typeof d.progressText === 'string') setProgressText(d.progressText);
      if (Array.isArray(d.progressLog)) setProgressLog(d.progressLog);
      if (Array.isArray(d.cloneLog)) setCloneLog(d.cloneLog);
      if (d.detectedPreview && typeof d.detectedPreview === 'object')
        setDetectedPreview(d.detectedPreview);
      if (d.previewDecision && typeof d.previewDecision === 'object')
        setPreviewDecision(d.previewDecision);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => persistDraftSync(), 400);
    return () => clearTimeout(t);
  }, [persistDraftSync]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') handleRequestClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleRequestClose]);

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) handleRequestClose();
  };

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-[100] flex flex-col bg-gray-950 text-white'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm'
      }
      onClick={isFullscreen ? undefined : handleBackdropClick}
    >
      {isFullscreen && (
        <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-3 py-3 sm:px-5">
          <button
            type="button"
            onClick={handleRequestClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
            aria-label="Back"
          >
            <ArrowLeft size={18} className="text-gray-400" />
            Back
          </button>
          <h1 className="min-w-0 flex-1 text-center text-base font-semibold text-white sm:text-left">
            Import existing project
          </h1>
          <button
            type="button"
            onClick={handleRequestClose}
            className="rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
            aria-label="Close"
          >
            Close
          </button>
        </header>
      )}

      <div
        className={
          isFullscreen
            ? 'relative mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8'
            : 'relative mx-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl'
        }
        onClick={(e) => e.stopPropagation()}
      >
        {!isFullscreen && (
          <button
            onClick={handleRequestClose}
            className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-white"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {!isFullscreen && (
          <h2 className="mb-4 text-lg font-semibold text-white">Import existing project</h2>
        )}

        {!isFullscreen && <StepIndicator currentStep={step} />}

        {/* Step 1: Select Folder or Clone */}
        {step === 1 && (
          <div className="space-y-4">
            {/* Source mode toggle */}
            <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
              <button
                onClick={() => setSourceMode('local')}
                className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  sourceMode === 'local'
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                  />
                </svg>
                Local Directory
              </button>
              <button
                onClick={() => setSourceMode('clone')}
                className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  sourceMode === 'clone'
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                  />
                </svg>
                Clone from GitHub
              </button>
            </div>

            {/* Local directory mode */}
            {sourceMode === 'local' && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Project Path</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/path/to/your/project"
                    className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                    autoFocus
                  />
                  {isElectronLocal ? (
                    <button
                      onClick={async () => {
                        const dir = await window.electronAPI.selectDirectory();
                        if (dir) setPath(dir);
                      }}
                      className="px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-sm text-gray-200 transition-colors flex-shrink-0"
                      title="Browse local filesystem..."
                    >
                      <svg
                        className="w-4 h-4 inline mr-1"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                        />
                      </svg>
                      Browse
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowBrowser(true)}
                      className="px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-sm text-gray-200 transition-colors flex-shrink-0"
                      title={
                        isRemote
                          ? 'Browse remote server filesystem...'
                          : 'Browse server filesystem...'
                      }
                    >
                      <svg
                        className="w-4 h-4 inline mr-1"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                        />
                      </svg>
                      Browse{isRemote ? ' Server' : ''}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Clone from GitHub mode */}
            {sourceMode === 'clone' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Repository URL
                  </label>
                  <input
                    type="text"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="https://github.com/org/repo or git@github.com:org/repo.git"
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors font-mono"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Clone Into{' '}
                    <span className="text-gray-500 font-normal">
                      (optional — defaults to ~/projects)
                    </span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cloneTarget}
                      onChange={(e) => setCloneTarget(e.target.value)}
                      placeholder="~/projects"
                      className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                    />
                    {isElectronLocal ? (
                      <button
                        onClick={async () => {
                          const dir = await window.electronAPI.selectDirectory();
                          if (dir) setCloneTarget(dir);
                        }}
                        className="px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-sm text-gray-200 transition-colors flex-shrink-0"
                      >
                        <svg
                          className="w-4 h-4 inline mr-1"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                          />
                        </svg>
                        Browse
                      </button>
                    ) : (
                      <button
                        onClick={() => setShowTargetBrowser(true)}
                        className="px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-sm text-gray-200 transition-colors flex-shrink-0"
                      >
                        <svg
                          className="w-4 h-4 inline mr-1"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                          />
                        </svg>
                        Browse{isRemote ? ' Server' : ''}
                      </button>
                    )}
                  </div>
                </div>

                {/* Clone progress */}
                {(cloning || cloneLog.length > 0) && (
                  <div
                    ref={terminalRef}
                    className="bg-gray-950 font-mono text-xs text-green-400 p-3 rounded-lg max-h-32 overflow-y-auto whitespace-pre-wrap"
                  >
                    {cloneLog.map((line, i) => (
                      <div
                        key={i}
                        className={
                          i === cloneLog.length - 1 && cloning
                            ? 'text-green-300'
                            : 'text-green-400/60'
                        }
                      >
                        {i === cloneLog.length - 1 && cloning ? '▸ ' : '  '}
                        {line}
                      </div>
                    ))}
                  </div>
                )}

                {/* Clone error */}
                {cloneError && (
                  <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                    {cloneError}
                  </div>
                )}

                {/* Clone success: show resolved path */}
                {!cloning &&
                  path &&
                  sourceMode === 'clone' &&
                  !cloneError &&
                  cloneLog.length > 0 && (
                    <div className="bg-emerald-900/20 border border-emerald-700/50 rounded-lg p-3 text-sm text-emerald-300 flex items-center gap-2">
                      <svg
                        className="w-4 h-4 flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      Cloned to: <span className="font-mono text-xs">{path}</span>
                    </div>
                  )}
              </div>
            )}

            {/* Shared fields: Name, ID, Color */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameManuallyEdited(true);
                  }}
                  placeholder="My Project"
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Project ID</label>
                <input
                  type="text"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setIdManuallyEdited(true);
                  }}
                  placeholder="my-project"
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Color</label>
              <div className="flex items-center gap-2 flex-wrap">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-8 h-8 rounded-full transition-all ${
                      color === c
                        ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900 scale-110'
                        : 'hover:scale-105'
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
                <label className="relative w-8 h-8 rounded-full overflow-hidden cursor-pointer border-2 border-dashed border-gray-500 hover:border-gray-400 transition-colors flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </label>
                <div
                  className="w-8 h-8 rounded-full border-2 border-gray-600 ml-1"
                  style={{ backgroundColor: color }}
                  title={`Selected: ${color}`}
                />
              </div>
            </div>

            <div className="pt-2">
              {sourceMode === 'local' ? (
                <button
                  onClick={handleAnalyze}
                  disabled={!path.trim()}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
                >
                  Analyze Project
                </button>
              ) : !path ? (
                <button
                  onClick={handleClone}
                  disabled={!cloneUrl.trim() || cloning}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {cloning && <Spinner size={4} />}
                  {cloning ? 'Cloning...' : 'Clone Repository'}
                </button>
              ) : (
                <button
                  onClick={handleAnalyze}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors"
                >
                  Analyze Project
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Analysis */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Terminal output */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                {analyzing && <Spinner />}
                <span className="text-sm font-medium text-gray-300">
                  {analyzing
                    ? 'Analyzing project...'
                    : analysisError
                      ? 'Analysis failed'
                      : 'Analysis complete'}
                </span>
              </div>
              <div
                ref={terminalRef}
                className="bg-gray-950 font-mono text-xs text-green-400 p-4 rounded-lg max-h-64 overflow-y-auto whitespace-pre-wrap"
              >
                {progressLog.length > 0
                  ? progressLog.map((line, i) => (
                      <div
                        key={i}
                        className={
                          i === progressLog.length - 1 ? 'text-green-300' : 'text-green-400/60'
                        }
                      >
                        {i === progressLog.length - 1 && analyzing ? '▸ ' : '  '}
                        {line}
                      </div>
                    ))
                  : progressText || (analyzing ? 'Waiting for Claude to start...' : '')}
              </div>
            </div>

            {/* Error state */}
            {analysisError && !analyzing && (
              <div className="space-y-3">
                <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                  {analysisError}
                </div>
                <button
                  onClick={() => {
                    setStep(1);
                    setAnalysisError(null);
                  }}
                  className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                >
                  Back
                </button>
              </div>
            )}

            {/* Success state */}
            {analysisResult && !analyzing && (
              <div className="space-y-4">
                {/* Tech stack */}
                {analysisResult.techStack?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-2">Tech Stack</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {analysisResult.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded-full text-xs"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description */}
                {analysisResult.description && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-1">Description</h4>
                    <p className="text-sm text-gray-400">{analysisResult.description}</p>
                  </div>
                )}

                {/* Suggested agents — lead/sub hierarchy */}
                {analysisResult.agents?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-2">Agent Team</h4>
                    <div className="space-y-2">
                      {analysisResult.agents.map((agent, i) => {
                        const isLead =
                          agent.role === 'lead' || (i === 0 && analysisResult.agents.length > 1);
                        const isSub = !isLead && analysisResult.agents.length > 1;
                        return (
                          <div
                            key={i}
                            className={`bg-gray-800 rounded-lg p-3 border ${isLead ? 'border-amber-600/50' : 'border-gray-700'} ${isSub ? 'ml-6' : ''}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              {isSub && <span className="text-gray-600 text-xs">└</span>}
                              <span className="font-medium text-sm text-white">{agent.name}</span>
                              {isLead && (
                                <span className="bg-amber-900/50 text-amber-300 px-2 py-0.5 rounded-full text-xs font-medium">
                                  Lead
                                </span>
                              )}
                              {isSub && (
                                <span className="bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded-full text-xs">
                                  Sub-agent
                                </span>
                              )}
                            </div>
                            {agent.specialty && (
                              <p className="text-xs text-gray-400">{agent.specialty}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    onClick={() => {
                      setStep(1);
                      setAnalysisResult(null);
                      setProgressText('');
                    }}
                    className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => {
                      setStep(3);
                      detectGitHub();
                    }}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: GitHub Connection */}
        {step === 3 && (
          <div className="space-y-4">
            {ghLoading ? (
              <div className="flex items-center gap-3 py-8 justify-center">
                <Spinner />
                <span className="text-sm text-gray-400">Detecting GitHub configuration...</span>
              </div>
            ) : (
              <>
                {/* Auth Status */}
                <div
                  className={`rounded-lg p-4 border ${ghStatus?.authenticated ? 'bg-emerald-900/20 border-emerald-700/50' : 'bg-gray-800 border-gray-700'}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className={`w-2 h-2 rounded-full ${ghStatus?.authenticated ? 'bg-emerald-400' : 'bg-gray-500'}`}
                    />
                    <span
                      className={`text-sm font-medium ${ghStatus?.authenticated ? 'text-emerald-300' : 'text-gray-300'}`}
                    >
                      {ghStatus?.authenticated
                        ? `Authenticated as ${ghStatus.user}${
                            ghStatus.source === 'github'
                              ? ' (via your GitHub account)'
                              : ghStatus.source === 'gh-cli'
                                ? ' (via gh CLI)'
                                : ''
                          }`
                        : 'Not connected to GitHub'}
                    </span>
                  </div>
                  {ghStatus?.authenticated && ghStatus.scopes?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 pl-4">
                      {ghStatus.scopes.map((s) => (
                        <span
                          key={s}
                          className="bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-mono"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  {!ghStatus?.authenticated && (
                    <div className="mt-3 pl-4 space-y-3">
                      <p className="text-xs text-gray-400 leading-relaxed">
                        Connect a GitHub account so Agent Hub can list your PRs and merge, close, or
                        comment as you. No CLI required.
                      </p>

                      {showTokenInput ? (
                        <div className="space-y-2">
                          <label className="block text-xs font-medium text-gray-400">
                            Personal access token
                          </label>
                          <input
                            type="password"
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            placeholder="ghp_… or github_pat_…"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-testid="github-pat-input"
                            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
                          />
                          <p className="text-[11px] text-gray-500 leading-relaxed">
                            Generate one at{' '}
                            <a
                              href="https://github.com/settings/tokens?type=beta"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:text-gray-300"
                            >
                              github.com/settings/tokens
                            </a>
                            . A fine-grained token with read access to your repositories is enough
                            for PR listing; add <code>contents:write</code> +{' '}
                            <code>pull_requests:write</code> if you want merge/comment to work.
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleSaveToken}
                              disabled={!tokenInput.trim() || tokenSaving}
                              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                            >
                              {tokenSaving && <Spinner size={3} />}
                              {tokenSaving ? 'Saving…' : 'Save token'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setShowTokenInput(false);
                                setTokenInput('');
                                setTokenError(null);
                              }}
                              disabled={tokenSaving}
                              className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-xs px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                          {tokenError && (
                            <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
                              {tokenError}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {ghStatus?.serverConfigured !== false && (
                            <button
                              type="button"
                              onClick={handleStartOAuth}
                              disabled={oauthBusy}
                              className="bg-[#24292f] hover:bg-[#1c2024] disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                            >
                              {oauthBusy && <Spinner size={3} />}
                              Sign in with GitHub
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setShowTokenInput(true);
                              setTokenError(null);
                            }}
                            disabled={oauthBusy}
                            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                          >
                            {ghStatus?.serverConfigured === false
                              ? 'Paste a personal access token'
                              : 'Use a personal access token'}
                          </button>
                          <button
                            type="button"
                            onClick={detectGitHub}
                            disabled={oauthBusy}
                            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Retry Detection
                          </button>
                        </div>
                      )}
                      {oauthError && (
                        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
                          {oauthError}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Repo Connection */}
                {ghStatus?.authenticated && (
                  <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
                    <h4 className="text-sm font-medium text-gray-300">Repository Connection</h4>
                    {repoInfo?.hasRemote && (
                      <p className="text-xs text-gray-500">
                        Detected remote:{' '}
                        <span className="font-mono text-gray-400">{repoInfo.url}</span>
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Owner</label>
                        <input
                          type="text"
                          value={repoOwner}
                          onChange={(e) => {
                            setRepoOwner(e.target.value);
                            setTestResult(null);
                          }}
                          placeholder="org-or-user"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Repository</label>
                        <input
                          type="text"
                          value={repoName}
                          onChange={(e) => {
                            setRepoName(e.target.value);
                            setTestResult(null);
                          }}
                          placeholder="repo-name"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                        />
                      </div>
                    </div>

                    {/* Test connection */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={testGitHubConnection}
                        disabled={!repoOwner || !repoName || testing}
                        className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                      >
                        {testing && <Spinner size={3} />}
                        {testing ? 'Testing...' : 'Test Connection'}
                      </button>
                      {testResult && (
                        <span
                          className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}
                        >
                          {testResult.ok
                            ? `Connected — ${testResult.repoInfo.full_name} (${testResult.repoInfo.private ? 'private' : 'public'})`
                            : testResult.error}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setStep(2)}
                className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => {
                  setSkipGitHub(true);
                  setStep(4);
                }}
                className="text-gray-400 hover:text-gray-200 text-sm px-4 py-2 rounded-lg transition-colors"
              >
                Skip
              </button>
              <button
                onClick={() => {
                  setSkipGitHub(false);
                  setStep(4);
                }}
                disabled={!ghStatus?.authenticated || (!repoOwner && !repoName)}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Review & Create */}
        {step === 4 && (
          <div className="space-y-4">
            {/* Preview defaults confirmation — only when the server's
                detect-preview-defaults broadcast returned a recognised stack.
                Empty / null detection deliberately renders nothing so users
                with non-web projects see no scary "no preview" modal. */}
            {detectedPreview && (
              <PreviewConfirm
                detected={detectedPreview}
                onConfirm={(form) => setPreviewDecision(form)}
                onSkip={() => setPreviewDecision({ enabled: false })}
              />
            )}

            {/* Agent cards with checkboxes */}
            {analysisResult?.agents?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-300 mb-2">Agent Team</h4>
                <div className="space-y-2">
                  {analysisResult.agents.map((agent, i) => {
                    const isLead =
                      agent.role === 'lead' || (i === 0 && analysisResult.agents.length > 1);
                    const isSub = !isLead && analysisResult.agents.length > 1;
                    return (
                      <label
                        key={i}
                        className={`flex items-start gap-3 bg-gray-800 rounded-lg p-3 border cursor-pointer transition-colors ${isSub ? 'ml-6' : ''} ${
                          selectedAgents[i]
                            ? isLead
                              ? 'border-amber-600/50'
                              : 'border-emerald-600'
                            : 'border-gray-700 opacity-60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!!selectedAgents[i]}
                          onChange={() => setSelectedAgents((prev) => ({ ...prev, [i]: !prev[i] }))}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            {isSub && <span className="text-gray-600 text-xs">└</span>}
                            <span className="font-medium text-sm text-white">{agent.name}</span>
                            {isLead && (
                              <span className="bg-amber-900/50 text-amber-300 px-2 py-0.5 rounded-full text-xs font-medium">
                                Lead
                              </span>
                            )}
                            {isSub && (
                              <span className="bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded-full text-xs">
                                Sub-agent
                              </span>
                            )}
                          </div>
                          {agent.specialty && (
                            <p className="text-xs text-gray-400">{agent.specialty}</p>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Context file tabs */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-2">Context Files</h4>
              <div className="flex gap-1 mb-2 flex-wrap">
                {CONTEXT_FILE_TABS.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      activeTab === tab
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <textarea
                value={contextFiles[activeTab] || ''}
                onChange={(e) =>
                  setContextFiles((prev) => ({ ...prev, [activeTab]: e.target.value }))
                }
                rows={8}
                placeholder={`Content for ${activeTab}...`}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-y transition-colors"
              />
            </div>

            {/* Error */}
            {analysisError && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                {analysisError}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => {
                  setStep(3);
                  setAnalysisError(null);
                }}
                className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:text-emerald-300 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
              >
                {creating && <Spinner size={4} />}
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        )}
        {/* Server-side directory browser modals */}
        <ServerBrowser
          isOpen={showBrowser}
          onClose={() => setShowBrowser(false)}
          onSelect={(dir) => setPath(dir)}
          initialPath={path || ''}
        />
        <ServerBrowser
          isOpen={showTargetBrowser}
          onClose={() => setShowTargetBrowser(false)}
          onSelect={(dir) => setCloneTarget(dir)}
          initialPath={cloneTarget || ''}
        />
      </div>
    </div>
  );
}
