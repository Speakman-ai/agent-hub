/**
 * RumSettingsSection — AI RUM (real user monitoring) setup panel
 * (per-project sidebar route `rum:<projectId>`).
 *
 * Mirrors FinalizeSettingsSection / PreviewSection: a read-only repo scan
 * (`rum/setup-draft`) that surfaces the detected framework, injection
 * target, and CSP locations; a "Set up RUM" button that spawns the
 * worktree-backed `[RUM Setup]` wizard session and opens it in chat; and an
 * ingest-client manager that mints / lists / revokes the per-project
 * `X-RUM-Token` credentials a vendor site uses to upload replays.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity,
  Loader2,
  AlertCircle,
  Sparkles,
  Key,
  Plus,
  Trash2,
  Check,
  Copy,
  ShieldCheck,
  Video,
  RefreshCw,
} from 'lucide-react';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/export';
import { relativeTime } from '../utils/time';
import {
  isSessionReplayEnabled,
  setSessionReplayEnabled,
  isMaskAllEnabled,
  setReplayMaskingMode,
} from '../utils/sessionReplay';

/**
 * Format an ingest client's `lastUsedAt` for display. Returns "never used"
 * when the token has never authenticated an upload, otherwise a relative
 * timestamp ("2m ago") via the shared `relativeTime` helper (which parses
 * SQLite no-TZ datetimes as UTC). Falls back to "never used" if the helper
 * cannot parse the value, so we never render a raw backend timestamp.
 */
export function formatLastUsed(lastUsedAt: any) {
  if (!lastUsedAt) return 'never used';
  const rel = relativeTime(lastUsedAt);
  return rel ? `last used ${rel}` : 'never used';
}

const FRAMEWORK_LABELS = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  remix: 'Remix',
  astro: 'Astro',
  vue: 'Vue',
  angular: 'Angular',
  react: 'React',
  vanilla: 'Vanilla / static HTML',
  unknown: 'Unknown',
} as Record<string, any>;

const INJECTION_STYLE_LABELS = {
  'module-init': 'Module init (import + start call)',
  'client-component': 'Client component (Next app-router layout)',
  'script-tag': 'Inline <script> tag',
} as Record<string, any>;

export default function RumSettingsSection({ projects = [], onOpenSession, showToast }: any) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');

  // Draft scan state
  const [draft, setDraft] = useState<any>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState<any>(null);

  // Wizard spawn state
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState<any>(null);
  const [lastSessionId, setLastSessionId] = useState<any>(null);
  // Masking policy baked into the recorder the wizard injects into THIS target
  // app (distinct from the Hub's own self-recording toggle above). Default
  // false = mask passwords + PII only, record other content — matches
  // rum/mask.js DEFAULT_MASK_OPTIONS and suits most third-party apps.
  const [injectMaskAllText, setInjectMaskAllText] = useState(false);

  // Session-replay recorder on/off (global to this Hub, persisted in
  // localStorage via setSessionReplayEnabled — not per-project).
  const [replayOn, setReplayOn] = useState(() => isSessionReplayEnabled());
  const [replayToggling, setReplayToggling] = useState(false);
  const [maskAll, setMaskAll] = useState(() => isMaskAllEnabled());
  const [maskToggling, setMaskToggling] = useState(false);

  // Per-project server-delivered replay policy. Unlike the per-browser toggle
  // above, this is saved on the project (PATCH /api/projects/:id { replay }) so
  // it applies to every user. `continuous` is the whole-session continuous-
  // capture opt-in (OFF by default); turning it on makes mask-all a strong
  // default for the project. `enforceMaskAll` is the Admin override for that
  // default: ON (the default) keeps mask-all enforced; an Admin can turn it OFF
  // to record un-masked whole sessions. It maps to persisted
  // `replay.maskAllEnforced` (absent = enforced default; `false` = opted out).
  const [replaySampleRate, setReplaySampleRate] = useState<number>(0);
  const [continuous, setContinuous] = useState(false);
  const [enforceMaskAll, setEnforceMaskAll] = useState(true);
  const [savingReplayConfig, setSavingReplayConfig] = useState(false);
  const [replayConfigError, setReplayConfigError] = useState<any>(null);

  // Per-tenant extended-retention window (months) applied when an operator flags
  // an individual session in the replay player to keep it past the default
  // window (up to 15). Persisted on the project's `replay` config.
  const [extendedRetentionMonths, setExtendedRetentionMonths] = useState<number>(15);
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionError, setRetentionError] = useState<any>(null);

  // Per-tenant BASE (hot/index) retention window override in days. `0` means "use
  // the platform default" (no override persisted). Tighten-only: a value longer
  // than the platform default resolves back to the default server-side. Persisted
  // on the project's `replay` config.
  const [baseRetentionDays, setBaseRetentionDays] = useState<number>(0);
  const [savingBaseRetention, setSavingBaseRetention] = useState(false);

  // Ingest-client state
  const [clients, setClients] = useState<any[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientsError, setClientsError] = useState<any>(null);
  const [newClientName, setNewClientName] = useState('');
  const [minting, setMinting] = useState(false);
  const [freshToken, setFreshToken] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<any>(null);

  // The project the UI currently belongs to. Async loads capture the `pid`
  // they were started for and only commit state when it still matches this
  // ref — otherwise a slow response for project A could overwrite project
  // B's scan / token list after the user switched (and, worse, surface or
  // act on another project's ingest credentials). The ref is set
  // synchronously in the project-change effect before any load starts.
  const activePidRef = useRef('');

  useEffect(() => {
    if (!projects.length) {
      setProjectId('');
      return;
    }
    if (!projects.find((p: any) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  const reloadDraft = useCallback(async (pid: any) => {
    if (!pid) return;
    setLoadingDraft(true);
    setDraftError(null);
    try {
      const res = await api.getRumSetupDraft(pid);
      if (activePidRef.current !== pid) return; // stale — project changed
      setDraft(res?.draft || null);
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setDraftError(err?.message || 'Failed to scan project');
      setDraft(null);
    } finally {
      if (activePidRef.current === pid) setLoadingDraft(false);
    }
  }, []);

  const reloadClients = useCallback(async (pid: any) => {
    if (!pid) return;
    setLoadingClients(true);
    setClientsError(null);
    try {
      const res = await api.getRumClients(pid);
      if (activePidRef.current !== pid) return; // stale — project changed
      setClients(res?.clients || []);
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setClientsError(err?.message || 'Failed to load ingest clients');
      setClients([]);
    } finally {
      if (activePidRef.current === pid) setLoadingClients(false);
    }
  }, []);

  // Resolve the effective policy as well as the persisted project shape. The
  // environment may provide a different mask-all default (for example ST/test
  // opts out through Terraform), so reading only project.replay would make the
  // admin control display the wrong state for projects without an explicit
  // override.
  const reloadReplayPolicy = useCallback(async (pid: any) => {
    if (!pid || typeof api.getReplayConfig !== 'function') return;
    try {
      const policy = await api.getReplayConfig(pid);
      if (activePidRef.current !== pid) return;
      if (typeof policy?.maskAllEnforced === 'boolean') {
        setEnforceMaskAll(policy.maskAllEnforced);
      }
    } catch {
      // The project shape remains a safe fallback when the public policy read
      // is unavailable during startup or on an older server.
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    // Mark this project active BEFORE any async load so in-flight responses
    // for the previous project are discarded when they resolve.
    activePidRef.current = projectId;
    // Reset transient + data state so the previous project's scan / tokens
    // never linger on screen while the new project's loads are in flight.
    setFreshToken(null);
    setCopied(false);
    setWizardError(null);
    setLastSessionId(null);
    setDraft(null);
    setClients([]);
    // Clear transient mutation flags too: a guarded wizard/mint/revoke for
    // the previous project skips its own reset (correctly), so reset here to
    // avoid a button stuck disabled after the switch.
    setWizardStarting(false);
    setMinting(false);
    setRevokingId(null);
    setClientsError(null);
    void reloadDraft(projectId);
    void reloadClients(projectId);
    void reloadReplayPolicy(projectId);
  }, [projectId, reloadDraft, reloadClients, reloadReplayPolicy]);

  const project = projects.find((p: any) => p.id === projectId) || null;

  // Sync the per-project replay config form from the selected project whenever
  // it changes (the projects prop is the source of truth, refreshed via WS).
  // Also clear the saving flag: a save started for the previous project guards
  // its catch/finally on the active pid, so if it resolves after the switch it
  // never clears `savingReplayConfig` for the new selection — which would leave
  // the new project's controls permanently disabled. Resetting here mirrors how
  // the other in-flight mutation flags are cleared on project change.
  useEffect(() => {
    const cfg = (project as any)?.replay || {};
    setReplaySampleRate(typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 0);
    setContinuous(cfg.continuous === true);
    // Absent maskAllEnforced = strong default (enforced); only an explicit
    // `false` is the Admin opt-out.
    setEnforceMaskAll(cfg.maskAllEnforced !== false);
    setReplayConfigError(null);
    setSavingReplayConfig(false);
    setExtendedRetentionMonths(
      typeof cfg.extendedRetentionMonths === 'number' ? cfg.extendedRetentionMonths : 15,
    );
    setRetentionError(null);
    setSavingRetention(false);
    setBaseRetentionDays(typeof cfg.retentionDays === 'number' ? cfg.retentionDays : 0);
    setSavingBaseRetention(false);
  }, [project]);

  // Persist the per-project replay sample rate. The operator's choice is always
  // persisted explicitly — including `sampleRate: 0` for "Off (0%)". An ABSENT
  // sampleRate means "unconfigured → fall back to the client default" on the
  // server/recorder side, so dropping a 0 here would make "Off" silently become
  // the default rate. The project's existing `continuous` flag (set by the
  // opt-in card 1106, never by this UI) is preserved so editing the rate here
  // can't clobber it. Optimistic state was already set by the caller; on failure
  // we surface the error and revert to the project's persisted value.
  const saveReplayConfig = useCallback(
    async (next: { sampleRate: number }) => {
      if (!project) return;
      const pid = project.id;
      setSavingReplayConfig(true);
      setReplayConfigError(null);
      const replay: Record<string, unknown> = { sampleRate: next.sampleRate };
      // Preserve a continuous opt-in (and its mask-all Admin override) set
      // elsewhere — the `replay` config is replaced wholesale on PATCH, so
      // editing only the rate must not clobber the privacy decision.
      if ((project as any)?.replay?.continuous === true) {
        replay.continuous = true;
        if ((project as any)?.replay?.maskAllEnforced === false) replay.maskAllEnforced = false;
      }
      try {
        await api.updateProject(pid, { replay });
        if (showToast) showToast('Replay sample rate saved for this project.', 'success', 2500);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setReplayConfigError(err?.message || 'Failed to save replay sample rate');
        const cfg = (project as any)?.replay || {};
        setReplaySampleRate(typeof cfg.sampleRate === 'number' ? cfg.sampleRate : 0);
      } finally {
        if (activePidRef.current === pid) setSavingReplayConfig(false);
      }
    },
    [project, showToast],
  );

  const handleChangeReplaySampleRate = useCallback(
    (value: number) => {
      setReplaySampleRate(value);
      void saveReplayConfig({ sampleRate: value });
    },
    [saveReplayConfig],
  );

  // Opt the project into (or out of) whole-session continuous capture. The
  // `replay` config is replaced wholesale on PATCH, so the current sample rate
  // is sent alongside `continuous` to preserve it. mask-all enforcement is a
  // continuous-tier control: the server does not persist `maskAllEnforced` while
  // continuous is off, so enabling continuous always starts from the enforced
  // strong default (an Admin can opt out again afterwards). We therefore reset
  // the local override to enforced on enable, keeping the UI consistent with
  // what gets persisted. Optimistic; on failure (e.g. a 403 for a non-admin) we
  // surface the error and revert.
  const handleToggleContinuous = useCallback(async () => {
    if (!project || savingReplayConfig) return;
    const pid = project.id;
    const next = !continuous;
    setContinuous(next);
    // Enabling continuous defaults mask-all back ON (matches the persisted
    // config: no `maskAllEnforced` is sent, so the server resolves enforced).
    if (next) setEnforceMaskAll(true);
    setSavingReplayConfig(true);
    setReplayConfigError(null);
    try {
      await api.updateProject(pid, { replay: { sampleRate: replaySampleRate, continuous: next } });
      if (showToast) {
        showToast(
          next
            ? 'Continuous capture enabled for this project — mask-all is enforced.'
            : 'Continuous capture disabled for this project.',
          next ? 'success' : 'info',
          4000,
        );
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setReplayConfigError(err?.message || 'Failed to update continuous capture');
      const cfg = (project as any)?.replay || {};
      setContinuous(cfg.continuous === true);
      setEnforceMaskAll(cfg.maskAllEnforced !== false);
    } finally {
      if (activePidRef.current === pid) setSavingReplayConfig(false);
    }
  }, [project, savingReplayConfig, continuous, replaySampleRate, showToast]);

  // Admin override for the continuous-tier mask-all default. Default ON
  // (enforced); turning it OFF persists `replay.maskAllEnforced: false`, so
  // whole sessions record un-masked input values + visible text. Sent alongside
  // the current rate + continuous flag (the config is replaced wholesale).
  // Optimistic; on failure (e.g. a 403 for a non-admin) we surface and revert.
  const handleToggleEnforceMaskAll = useCallback(async () => {
    if (!project || savingReplayConfig || !continuous) return;
    const pid = project.id;
    const nextEnforced = !enforceMaskAll;
    setEnforceMaskAll(nextEnforced);
    setSavingReplayConfig(true);
    setReplayConfigError(null);
    const replay: Record<string, unknown> = { sampleRate: replaySampleRate, continuous: true };
    if (!nextEnforced) replay.maskAllEnforced = false;
    try {
      await api.updateProject(pid, { replay });
      if (showToast) {
        showToast(
          nextEnforced
            ? 'Mask-all re-enforced for continuous capture on this project.'
            : 'Mask-all override OFF — whole sessions record un-masked for this project.',
          nextEnforced ? 'success' : 'info',
          4500,
        );
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setReplayConfigError(err?.message || 'Failed to update mask-all enforcement');
      const cfg = (project as any)?.replay || {};
      setEnforceMaskAll(cfg.maskAllEnforced !== false);
    } finally {
      if (activePidRef.current === pid) setSavingReplayConfig(false);
    }
  }, [project, savingReplayConfig, continuous, enforceMaskAll, replaySampleRate, showToast]);

  // Persist the per-tenant extended-retention window. The `replay` config is
  // replaced wholesale on PATCH, so start from the project's persisted config and
  // overlay only the extended-retention key — this never clobbers the sampling
  // rates / quotas set elsewhere.
  const handleChangeExtendedRetentionMonths = useCallback(
    async (value: number) => {
      if (!project) return;
      const pid = project.id;
      setExtendedRetentionMonths(value);
      setSavingRetention(true);
      setRetentionError(null);
      const replay: Record<string, unknown> = {
        ...((project as any)?.replay || {}),
        extendedRetentionMonths: value,
      };
      try {
        await api.updateProject(pid, { replay });
        if (showToast) showToast('Retention settings saved for this project.', 'success', 2500);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setRetentionError(err?.message || 'Failed to save retention settings');
        const cfg = (project as any)?.replay || {};
        setExtendedRetentionMonths(
          typeof cfg.extendedRetentionMonths === 'number' ? cfg.extendedRetentionMonths : 15,
        );
      } finally {
        if (activePidRef.current === pid) setSavingRetention(false);
      }
    },
    [project, showToast],
  );

  const handleChangeBaseRetentionDays = useCallback(
    async (value: number) => {
      if (!project) return;
      const pid = project.id;
      setBaseRetentionDays(value);
      setSavingBaseRetention(true);
      setRetentionError(null);
      const replay: Record<string, unknown> = { ...((project as any)?.replay || {}) };
      // 0 = "platform default" → clear the override (a persisted 0 would fail the
      // must-be-positive validation).
      if (value > 0) replay.retentionDays = value;
      else delete replay.retentionDays;
      try {
        await api.updateProject(pid, { replay });
        if (showToast) showToast('Retention settings saved for this project.', 'success', 2500);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setRetentionError(err?.message || 'Failed to save retention settings');
        const cfg = (project as any)?.replay || {};
        setBaseRetentionDays(typeof cfg.retentionDays === 'number' ? cfg.retentionDays : 0);
      } finally {
        if (activePidRef.current === pid) setSavingBaseRetention(false);
      }
    },
    [project, showToast],
  );

  const handleToggleReplay = useCallback(async () => {
    if (replayToggling) return;
    const next = !replayOn;
    setReplayToggling(true);
    // Optimistic — the recorder start/stop is best-effort and never throws.
    setReplayOn(next);
    try {
      await setSessionReplayEnabled(next);
      if (showToast) {
        showToast(
          next ? 'Session replay recording enabled.' : 'Session replay recording disabled.',
          'success',
          3000,
        );
      }
    } finally {
      setReplayToggling(false);
    }
  }, [replayOn, replayToggling, showToast]);

  const handleToggleMaskAll = useCallback(async () => {
    if (maskToggling) return;
    const next = !maskAll;
    setMaskToggling(true);
    // Optimistic — setReplayMaskingMode is best-effort and never throws.
    setMaskAll(next);
    try {
      await setReplayMaskingMode(next);
      if (showToast) {
        showToast(
          next
            ? 'Masking all text & inputs.'
            : 'Masking password fields only — other content is recorded.',
          next ? 'success' : 'info',
          3500,
        );
      }
    } finally {
      setMaskToggling(false);
    }
  }, [maskAll, maskToggling, showToast]);

  const handleStartWizard = useCallback(async () => {
    if (!project || wizardStarting) return;
    // Capture the project this spawn belongs to. A late response must not
    // set lastSessionId/wizardError or focus a session from the now-active
    // project's view (same stale guard as the load/mint paths).
    const pid = project.id;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startRumWizard(pid, { maskAllText: injectMaskAllText });
      if (activePidRef.current !== pid) return; // switched projects — drop result
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      setLastSessionId(res.sessionId);
      if (typeof onOpenSession === 'function') {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      } else {
        setWizardError(
          `Wizard started (session ${res.sessionId}) — open it from the agent session list.`,
        );
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setWizardError(err?.message || 'Failed to start the RUM setup wizard');
    } finally {
      if (activePidRef.current === pid) setWizardStarting(false);
    }
  }, [project, wizardStarting, onOpenSession, injectMaskAllText]);

  const handleMint = useCallback(async () => {
    const name = newClientName.trim();
    if (!project || minting || !name) return;
    // Capture the project this mint belongs to. If the user navigates away
    // before the request resolves, the one-time plaintext token must NOT be
    // revealed in (or attributed to) the now-active project — same stale
    // guard as reloadDraft/reloadClients.
    const pid = project.id;
    setMinting(true);
    setClientsError(null);
    try {
      const minted = await api.createRumClient(pid, name);
      if (activePidRef.current !== pid) return; // switched projects — drop the secret
      setFreshToken(minted?.token || null);
      setCopied(false);
      setNewClientName('');
      await reloadClients(pid);
      if (showToast) {
        showToast('Ingest token created — copy it now. It is not shown again.', 'success', 6000);
      }
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setClientsError(err?.message || 'Failed to mint ingest token');
    } finally {
      if (activePidRef.current === pid) setMinting(false);
    }
  }, [project, minting, newClientName, reloadClients, showToast]);

  const handleCopyToken = useCallback(async () => {
    if (!freshToken) return;
    await copyToClipboard(freshToken);
    setCopied(true);
    if (showToast) showToast('Token copied to clipboard.', 'success', 2500);
  }, [freshToken, showToast]);

  const handleRevoke = useCallback(
    async (clientId: any) => {
      if (!project || revokingId) return;
      if (!window.confirm('Revoke this ingest token? Uploads using it will be rejected.')) {
        return;
      }
      // Capture the project this revoke belongs to. If the user switches
      // mid-DELETE, don't surface Alpha's success toast / error / spinner
      // reset in Beta's view (same stale guard as the load/mint paths).
      const pid = project.id;
      setRevokingId(clientId);
      setClientsError(null);
      try {
        await api.revokeRumClient(pid, clientId);
        if (activePidRef.current !== pid) return; // switched projects — drop result
        await reloadClients(pid);
        if (showToast) showToast('Ingest token revoked.', 'success', 3000);
      } catch (err: any) {
        if (activePidRef.current !== pid) return;
        setClientsError(err?.message || 'Failed to revoke token');
      } finally {
        if (activePidRef.current === pid) setRevokingId(null);
      }
    },
    [project, revokingId, reloadClients, showToast],
  );

  if (!projects.length) {
    return <p className="text-sm text-gray-500">No projects yet.</p>;
  }

  const plan = draft?.plan || null;
  const alreadyInstrumented = !!plan?.alreadyInstrumented;

  return (
    <div className="space-y-6 pb-28">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Activity size={18} className="text-fuchsia-400" />
          RUM (Real User Monitoring)
        </h3>
        <p className="text-xs text-gray-500 max-w-2xl">
          Instrument this project&apos;s frontend with the rrweb session-replay recorder. Click{' '}
          <strong className="text-gray-300">Set up RUM</strong> to scan the repo and walk through a
          guided injection in chat, then mint a per-project ingest token for the recorder to
          authenticate replay uploads.
        </p>
      </div>

      {/* ── Session replay recording (global on/off) ────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
              <Video size={14} className="text-fuchsia-400" />
              Session replay recording
            </h4>
            <p className="text-xs text-gray-500 max-w-2xl">
              Records a privacy-masked rrweb replay of this Hub&apos;s own UI and attaches it to bug
              reports so the intake agent can see what happened. On by default; turn it off to stop
              recording entirely. Applies to this browser and persists across reloads.
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleReplay}
            disabled={replayToggling}
            role="switch"
            aria-checked={replayOn}
            aria-label="Toggle session replay recording"
            data-testid="rum-replay-toggle"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
              replayOn ? 'bg-fuchsia-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                replayOn ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Masking strictness */}
        <div className="mt-4 pt-4 border-t border-gray-700/70">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <h5 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-2">
                <ShieldCheck size={13} className="text-fuchsia-400" />
                Mask all text &amp; inputs
              </h5>
              <p className="text-xs text-gray-500 max-w-2xl">
                On (recommended for Agent Hub): redact every input value and all visible text — only
                structure, layout and interaction timing are recorded. Turn off to mask{' '}
                <strong className="text-gray-300">only password fields</strong> and record
                everything else verbatim — appropriate when instrumenting other apps that don&apos;t
                show secrets as text.
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleMaskAll}
              disabled={maskToggling}
              role="switch"
              aria-checked={maskAll}
              aria-label="Toggle masking of all text and inputs"
              data-testid="rum-mask-all-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
                maskAll ? 'bg-fuchsia-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  maskAll ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          {!maskAll && (
            <div
              className="mt-3 flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5"
              data-testid="rum-mask-all-warning"
            >
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                Passwords-only masking records all other input values and visible text in replays
                uploaded to the hub. Don&apos;t use this on surfaces that show chat, terminal
                output, tokens, or API keys.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Per-project replay sample rate (server-delivered) ───── */}
      <div
        className="bg-gray-800/50 border border-gray-700 rounded-xl p-4"
        data-testid="rum-replay-config"
      >
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
            <Activity size={14} className="text-fuchsia-400" />
            Replay sample rate (this project)
          </h4>
          <p className="text-xs text-gray-500 max-w-2xl">
            Server-delivered policy for <strong className="text-gray-300">all users</strong> of this
            project (not just this browser). Off (0%) by default; a set rate is authoritative for
            every user and overrides their per-browser toggle. The sample rate gates the
            continuous-capture tier.
          </p>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <label
            htmlFor="rum-replay-sample-rate"
            className="text-xs font-semibold text-gray-300 flex-1"
          >
            Session sample rate
          </label>
          <select
            id="rum-replay-sample-rate"
            data-testid="rum-replay-sample-rate"
            value={String(replaySampleRate)}
            disabled={!project || savingReplayConfig}
            onChange={(e: any) => handleChangeReplaySampleRate(Number(e.target.value))}
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-fuchsia-500 disabled:opacity-50"
          >
            <option value="0">Off (0%)</option>
            <option value="0.1">10%</option>
            <option value="0.25">25%</option>
            <option value="0.5">50%</option>
            <option value="1">100%</option>
          </select>
        </div>

        {/* Continuous-capture opt-in (Admin). OFF by default; mask-all on by default. */}
        <div className="mt-4 pt-4 border-t border-gray-700/70">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <h5 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-2">
                <Video size={13} className="text-fuchsia-400" />
                Continuous capture
              </h5>
              <p className="text-xs text-gray-500 max-w-2xl">
                Record <strong className="text-gray-300">whole sessions</strong> for this project
                instead of only the on-error window. Off by default — recording every screen of
                every user is a privacy decision. Turning it on{' '}
                <strong className="text-gray-300">defaults mask-all on</strong> for the project; an
                Admin can override that below. Requires Admin.
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleContinuous}
              disabled={!project || savingReplayConfig}
              role="switch"
              aria-checked={continuous}
              aria-label="Toggle continuous capture for this project"
              data-testid="rum-replay-continuous-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                continuous ? 'bg-fuchsia-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  continuous ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          {/* Admin override for the mask-all default (only while continuous is on). */}
          {continuous && (
            <div className="mt-4 pt-4 border-t border-gray-700/50">
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <h6 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-2">
                    <ShieldCheck size={13} className="text-fuchsia-400" />
                    Enforce mask-all
                  </h6>
                  <p className="text-xs text-gray-500 max-w-2xl">
                    On (recommended): redact every input value and all visible text for every user —
                    only structure and interactions are recorded. Turn off to record whole sessions{' '}
                    <strong className="text-gray-300">un-masked</strong> (passwords still masked).
                    Admin override of the continuous-tier privacy default.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggleEnforceMaskAll}
                  disabled={!project || savingReplayConfig}
                  role="switch"
                  aria-checked={enforceMaskAll}
                  aria-label="Toggle mask-all enforcement for continuous capture"
                  data-testid="rum-continuous-maskall-toggle"
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                    enforceMaskAll ? 'bg-fuchsia-600' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      enforceMaskAll ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {enforceMaskAll ? (
                <div
                  className="mt-3 flex items-start gap-2 text-xs text-fuchsia-200 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-lg p-2.5"
                  data-testid="rum-continuous-enforced-note"
                >
                  <ShieldCheck size={14} className="flex-shrink-0 mt-0.5" />
                  <span>
                    Mask-all is enforced for this project while continuous capture is on — input
                    values and visible text are redacted for every user; only structure and
                    interactions are recorded.
                  </span>
                </div>
              ) : (
                <div
                  className="mt-3 flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5"
                  data-testid="rum-continuous-unmasked-warning"
                >
                  <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>
                    Mask-all is OFF for continuous capture — whole sessions record all input values
                    and visible text (passwords still masked) for every user. Don&apos;t use this on
                    surfaces that show chat, terminal output, tokens, or API keys.
                  </span>
                </div>
              )}
            </div>
          )}
          {continuous && replaySampleRate <= 0 && (
            <div
              className="mt-3 flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5"
              data-testid="rum-continuous-rate-hint"
            >
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                The sample rate gates continuous capture. With the rate at Off (0%), no sessions are
                captured — set a rate above 0% for continuous capture to take effect.
              </span>
            </div>
          )}
        </div>

        {replayConfigError && (
          <p
            className="mt-3 text-xs text-red-400 flex items-center gap-1"
            data-testid="rum-replay-config-error"
          >
            <AlertCircle size={12} />
            {replayConfigError}
          </p>
        )}
      </div>

      {/* ── Per-project retention (two-tier) ────────────────────── */}
      <div
        className="bg-gray-800/50 border border-gray-700 rounded-xl p-4"
        data-testid="rum-retention-config"
      >
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
            <ShieldCheck size={14} className="text-fuchsia-400" />
            Retention (this project)
          </h4>
          <p className="text-xs text-gray-500 max-w-2xl">
            Captures live for the platform&apos;s default window, then expire. Flag an individual
            session in the replay player (the <strong className="text-gray-300">Keep</strong>{' '}
            button) to move it to the <strong className="text-gray-300">extended tier</strong> —
            kept for the window below (up to 15 months), with the clock starting when you flag it.
          </p>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <label
            htmlFor="rum-base-retention-days"
            className="text-xs font-semibold text-gray-300 flex-1"
          >
            Base-retention window (this project)
            <span className="block font-normal text-gray-500">
              Overrides the platform default. Can only shorten it, never extend past it.
            </span>
          </label>
          <select
            id="rum-base-retention-days"
            data-testid="rum-base-retention-days"
            value={String(baseRetentionDays)}
            disabled={!project || savingBaseRetention}
            onChange={(e: any) => handleChangeBaseRetentionDays(Number(e.target.value))}
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-fuchsia-500 disabled:opacity-50"
          >
            <option value="0">Platform default</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </select>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <label
            htmlFor="rum-extended-retention-months"
            className="text-xs font-semibold text-gray-300 flex-1"
          >
            Extended-retention window (flagged sessions)
          </label>
          <select
            id="rum-extended-retention-months"
            data-testid="rum-extended-retention-months"
            value={String(extendedRetentionMonths)}
            disabled={!project || savingRetention}
            onChange={(e: any) => handleChangeExtendedRetentionMonths(Number(e.target.value))}
            className="bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-fuchsia-500 disabled:opacity-50"
          >
            <option value="1">1 month</option>
            <option value="3">3 months</option>
            <option value="6">6 months</option>
            <option value="12">12 months</option>
            <option value="15">15 months (max)</option>
          </select>
        </div>

        {retentionError && (
          <p
            className="mt-3 text-xs text-red-400 flex items-center gap-1"
            data-testid="rum-retention-error"
          >
            <AlertCircle size={12} />
            {retentionError}
          </p>
        )}
      </div>

      {/* ── Repo scan summary ───────────────────────────────────── */}
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h4 className="text-sm font-semibold text-gray-300">Repo scan</h4>
          {!loadingDraft && projectId && (
            <button
              type="button"
              onClick={() => void reloadDraft(projectId)}
              data-testid="rum-draft-rescan"
              title="Re-run the repo scan for this project"
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            >
              <RefreshCw size={12} />
              Rescan
            </button>
          )}
        </div>
        {loadingDraft && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            Scanning project for framework, injection target, and CSP…
          </div>
        )}
        {draftError && (
          <p className="text-xs text-red-400 flex items-center gap-1">
            <AlertCircle size={12} />
            {draftError}
          </p>
        )}
        {!loadingDraft && !draftError && draft && (
          <div className="space-y-3" data-testid="rum-draft-summary">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
              {draft.webRoot && draft.webRoot !== '.' ? (
                <>
                  <dt className="text-gray-500">Web app root</dt>
                  <dd className="text-gray-300 font-mono" data-testid="rum-draft-web-root">
                    {draft.webRoot}/
                  </dd>
                </>
              ) : null}
              <dt className="text-gray-500">Framework</dt>
              <dd className="text-gray-300">
                {FRAMEWORK_LABELS[draft.framework] || draft.framework}
                {draft.typescript ? ' · TypeScript' : ''}
                {draft.packageManager ? ` · ${draft.packageManager}` : ''}
              </dd>

              <dt className="text-gray-500">Injection target</dt>
              <dd className="text-gray-300">
                {plan?.targetFile ? (
                  <code className="text-fuchsia-300">{plan.targetFile}</code>
                ) : (
                  <span className="text-amber-300">none detected — the wizard will ask</span>
                )}
              </dd>

              <dt className="text-gray-500">Injection style</dt>
              <dd className="text-gray-300">
                {plan?.injectionStyle
                  ? INJECTION_STYLE_LABELS[plan.injectionStyle] || plan.injectionStyle
                  : '—'}
              </dd>

              <dt className="text-gray-500">CSP locations</dt>
              <dd className="text-gray-300">
                {draft.cspHits?.length ? (
                  <span className="font-mono">
                    {draft.cspHits.map((h: any) => h.path).join(', ')}
                  </span>
                ) : (
                  <span className="text-gray-500">none found</span>
                )}
              </dd>

              <dt className="text-gray-500">Recorder</dt>
              <dd>
                {alreadyInstrumented ? (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <ShieldCheck size={12} /> already instrumented
                  </span>
                ) : draft.recorder?.dependencyPresent ? (
                  <span className="text-amber-300">dependency present, init not wired</span>
                ) : (
                  <span className="text-gray-500">not instrumented</span>
                )}
              </dd>
            </dl>
            {alreadyInstrumented && (
              <p className="text-xs text-emerald-400/90 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2">
                This project already has a wired recorder — re-running the wizard may
                double-instrument. Confirm in chat before applying edits.
              </p>
            )}
          </div>
        )}
        {/* Loaded, no error, but the scan produced no draft (e.g. the server
            returned an empty body, or the project cwd is unreadable). Without
            this branch the panel renders only its header — a blank box that
            reads as "Repo scan is showing nothing". Give the operator a clear
            message and a way to retry. */}
        {!loadingDraft && !draftError && !draft && (
          <div
            className="flex flex-col items-start gap-2 text-xs text-gray-400"
            data-testid="rum-draft-empty"
          >
            <p className="flex items-center gap-1.5">
              <AlertCircle size={12} className="text-amber-300" />
              The repo scan returned no result for this project. Its workspace may be empty or
              unreadable.
            </p>
            {projectId && (
              <button
                type="button"
                onClick={() => void reloadDraft(projectId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:bg-gray-800 transition-colors"
              >
                <RefreshCw size={12} />
                Rescan
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Guided setup ────────────────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-200 mb-1 flex items-center gap-2">
              <Sparkles size={14} className="text-fuchsia-400" />
              Guided setup walkthrough
            </h4>
            <p className="text-xs text-gray-500 max-w-xl">
              Spawns a worktree-backed session loaded with the{' '}
              <code className="text-gray-300">rum-setup</code> skill. It injects the rrweb recorder
              init into the detected target file, extends any Content-Security-Policy{' '}
              <code className="text-gray-300">connect-src</code> with the ingest origin, commits,
              and lets Finalize Code Changes open a PR for review.
            </p>
            {lastSessionId && (
              <p className="text-xs text-fuchsia-400 mt-2">
                Last wizard session: <code className="text-fuchsia-300">{lastSessionId}</code>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleStartWizard}
            disabled={!project || wizardStarting}
            className="flex items-center gap-2 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex-shrink-0"
          >
            {wizardStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {wizardStarting ? 'Starting…' : 'Set up RUM'}
          </button>
        </div>

        {/* Per-app masking policy baked into the injected recorder */}
        <div className="mt-3 pt-3 border-t border-gray-700/70">
          <label
            htmlFor="rum-inject-mask-mode"
            className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-2"
          >
            <ShieldCheck size={13} className="text-fuchsia-400" />
            Recorder masking for this app
          </label>
          <select
            id="rum-inject-mask-mode"
            data-testid="rum-inject-mask-select"
            value={injectMaskAllText ? 'mask-all' : 'passwords-only'}
            onChange={(e: any) => setInjectMaskAllText(e.target.value === 'mask-all')}
            disabled={wizardStarting}
            className="w-full max-w-md bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-fuchsia-500 disabled:opacity-50"
          >
            <option value="passwords-only">
              Mask passwords &amp; PII only — record other content
            </option>
            <option value="mask-all">Mask all text &amp; inputs — strictest</option>
          </select>
          <p className="text-xs text-gray-500 mt-1 max-w-xl">
            Baked into the recorder the wizard injects into{' '}
            <strong className="text-gray-300">this target app</strong> — independent of Agent
            Hub&apos;s own session-replay setting above. Default masks only password/PII fields so
            replays stay readable; choose strict masking for apps that show secrets as text.
          </p>
        </div>

        {wizardError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{wizardError}</span>
          </div>
        )}
      </div>

      {/* ── Ingest tokens ───────────────────────────────────────── */}
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
            <Key size={14} className="text-amber-400" />
            Ingest tokens
          </h4>
          <p className="text-xs text-gray-500 max-w-2xl">
            Per-project credentials the recorder sends as an{' '}
            <code className="text-gray-300">X-RUM-Token</code> header when uploading replays to{' '}
            <code className="text-gray-300">/api/replays</code>. The token is shown once at creation
            — copy it into the recorder config. Revoke any token to immediately reject its uploads.
          </p>
        </div>

        {/* One-time token reveal */}
        {freshToken && (
          <div
            className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
            data-testid="rum-fresh-token"
          >
            <div className="font-medium text-amber-200 mb-1">New ingest token (copy now)</div>
            <code className="block break-all font-mono text-amber-50/95">{freshToken}</code>
            <button
              type="button"
              onClick={handleCopyToken}
              className="mt-2 inline-flex items-center gap-1 text-sky-300 hover:text-sky-200"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <p className="mt-1 text-amber-200/70">
              This token will not be shown again. Store it securely.
            </p>
          </div>
        )}

        {/* Mint form */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newClientName}
            onChange={(e: any) => setNewClientName(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter') void handleMint();
            }}
            placeholder="Token name (e.g. production-web)"
            maxLength={100}
            className="flex-1 bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-fuchsia-500"
          />
          <button
            type="button"
            onClick={handleMint}
            disabled={!project || minting || !newClientName.trim()}
            className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-gray-100 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
          >
            {minting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Create token
          </button>
        </div>

        {clientsError && (
          <p className="text-xs text-red-400 flex items-center gap-1">
            <AlertCircle size={12} />
            {clientsError}
          </p>
        )}

        {/* Client list */}
        {loadingClients ? (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            Loading ingest tokens…
          </div>
        ) : clients.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No ingest tokens yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800/80" data-testid="rum-client-list">
            {clients.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-gray-200 truncate">{c.name}</p>
                  <p className="text-[11px] text-gray-500 font-mono truncate">
                    {c.prefix}… · {formatLastUsed(c.lastUsedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevoke(c.id)}
                  disabled={revokingId === c.id}
                  className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 disabled:text-gray-600 flex-shrink-0"
                >
                  {revokingId === c.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
