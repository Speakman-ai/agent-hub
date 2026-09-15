/**
 * AutopilotSettingsSection — Experimental Project Autopilot setup + run
 * controls (per-project sidebar view `autopilot` / `#/autopilot/<projectId>`).
 *
 * Operators enable the experiment and inspect or stop it without a shell. The
 * server (`server/routes/autopilot.ts`) owns all authority: this surface reads
 * `GET /projects/:id/autopilot`, renders the readiness checklist + run summary
 * derived by the shared `deriveAutopilotView`, and calls the config / start /
 * pause / resume / stop / disable endpoints. Admin gating here is a UX hint;
 * the server re-checks the role on every mutation.
 *
 * State survives reconnects because it is server-authoritative: we refetch on
 * mount, on `agenthub:ws_reconnected`, and poll while a run is active (there is
 * no dedicated Autopilot WebSocket event).
 */
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  Rocket,
  Loader2,
  AlertCircle,
  Check,
  X,
  RefreshCw,
  Play,
  Pause,
  Square,
} from 'lucide-react';
import { api } from '../utils/api';
import { hasRole, isLocalBundledDeployment } from '../utils/auth';
import {
  deriveAutopilotView,
  msToHours,
  hoursToMs,
  msToMinutes,
  minutesToMs,
  parseAutopilotCostCap,
  validateAutopilotLimitsForm,
  type AutopilotProjectStateWire,
  type AutopilotEvidenceView,
  type AutopilotDocumentationView,
} from '@shared/utils/autopilotView';

const ACTIVE_POLL_MS = 5000;

interface FormState {
  brief: string;
  targetId: string;
  origin: string;
  readinessProbeUrl: string;
  cycleMode: 'continuous' | 'finite';
  maxCycles: string;
  maxWallTimeHours: string;
  maxStageTimeoutMinutes: string;
  maxRetriesPerStage: string;
  maxCostUsd: string;
  credentialOwnerUserId: string;
}

function formFromState(state: AutopilotProjectStateWire | null): FormState {
  const c = state?.config;
  const l = c?.limits;
  return {
    brief: c?.brief ?? '',
    targetId: c?.target?.targetId ?? '',
    origin: c?.target?.origin ?? '',
    readinessProbeUrl: c?.target?.readinessProbeUrl ?? '',
    cycleMode: l?.cycleMode ?? 'continuous',
    maxCycles: l?.maxCycles != null ? String(l.maxCycles) : '',
    maxWallTimeHours: l ? String(msToHours(l.maxWallTimeMs) || 4) : '4',
    maxStageTimeoutMinutes: l ? String(msToMinutes(l.maxStageTimeoutMs) || 30) : '30',
    maxRetriesPerStage: l ? String(l.maxRetriesPerStage) : '2',
    maxCostUsd: l?.maxCostUsd != null ? String(l.maxCostUsd) : '',
    credentialOwnerUserId: c?.credentialOwnerUserId ?? '',
  };
}

function buildConfigBody(form: FormState, enabled: boolean) {
  const maxCycles = form.cycleMode === 'finite' ? Math.max(1, Number(form.maxCycles) || 1) : null;
  // `null` only for an explicitly empty field; an invalid nonempty value is
  // caught by saveConfig before we get here (it never silently clears the cap).
  const cap = parseAutopilotCostCap(form.maxCostUsd);
  const maxCostUsd = cap.ok ? cap.value : Number(form.maxCostUsd);
  return {
    enabled,
    brief: form.brief.trim() || null,
    target: {
      targetId: form.targetId.trim(),
      origin: form.origin.trim() || null,
      readinessProbeUrl: form.readinessProbeUrl.trim() || null,
    },
    limits: {
      cycleMode: form.cycleMode,
      maxCycles,
      maxWallTimeMs: hoursToMs(Number(form.maxWallTimeHours) || 4),
      maxStageTimeoutMs: minutesToMs(Number(form.maxStageTimeoutMinutes) || 30),
      maxRetriesPerStage: Math.min(2, Math.max(0, Number(form.maxRetriesPerStage) || 0)),
      maxCostUsd: maxCostUsd && maxCostUsd > 0 ? maxCostUsd : null,
    },
    credentialOwnerUserId: form.credentialOwnerUserId.trim() || null,
  };
}

export default function AutopilotSettingsSection({
  projectId,
  showToast,
}: {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
}) {
  const [state, setState] = useState<AutopilotProjectStateWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Stop is tracked independently of the serialized ordinary mutation so a
  // cancellation initiated mid-Save never releases the Save's in-flight slot.
  const [stopBusy, setStopBusy] = useState(false);
  const [form, setForm] = useState<FormState>(() => formFromState(null));
  // Only reset the form from the server when the user is not mid-edit, so a
  // background poll cannot wipe unsaved input.
  const dirtyRef = useRef(false);
  // App reuses this component across projects, so every async operation
  // (GET load AND mutation-triggered reload) captures the project it started
  // for and must confirm the project is still current before touching state —
  // otherwise a completion for project A can overwrite project B. `projectRef`
  // mirrors the latest projectId synchronously (updated on every render, before
  // any effect/async can resolve). `loadGenRef` additionally discards a
  // superseded same-project load.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const loadGenRef = useRef(0);
  // Bumped on every project switch. Together with the per-operation token below
  // this gives each mutation a unique identity that cannot recur across an
  // A → B → A navigation, so a stale completion can neither apply its result
  // nor release a newer operation's slot.
  const projectGenRef = useRef(0);
  // Monotonic edit revision. A background load or a save's reconciling reload
  // only repopulates the form when no newer edit has landed since it started,
  // so typing while a request is in flight is never clobbered.
  const editSeqRef = useRef(0);
  // The config revision the current form content is based on. Pinned to the
  // form, NOT to `state.config` — a background load/poll refreshes state (and
  // its revision) while a dirty form keeps the operator's edits, so reading the
  // live revision at save time would submit stale edits under a newer revision
  // and silently overwrite another client's write. Advanced only when the form
  // is (re)populated from the server or a save persists it.
  const formBaseRevisionRef = useRef<number | undefined>(undefined);
  // Increments every time the form is (re)populated from the server (load,
  // Refresh, project switch) — i.e. whenever the form's content lineage is
  // replaced. A save completion may only advance `formBaseRevisionRef` if this
  // hasn't changed since the save began; otherwise the form now holds different
  // server content and must keep the base revision that reload pinned.
  const formLoadGenRef = useRef(0);
  // Highest server-authored stateVersion whose activeRun we've applied. Every
  // activeRun application — GET load OR mutation response — must be at least
  // this fresh, so overlapping responses reconcile by SERVER state order (a
  // monotonic version the server stamps on both), never by client arrival
  // order. Reset on project switch.
  const appliedRunVersionRef = useRef(-1);
  // Unique, monotonically increasing token minted per mutation. Ownership of a
  // slot is proven by token identity, never by the (projectId, action-key)
  // pair — those repeat across navigation and let a stale op reclaim the slot.
  const opSeqRef = useRef(0);
  // Slots hold the token of the operation currently owning them (null = free).
  // Ordinary mutations (save/enable/start/pause/resume/disable) serialize
  // through `busyRef`; Stop uses its own `stopRef` so a completing Stop never
  // frees a still-pending Save.
  const busyRef = useRef<number | null>(null);
  const stopRef = useRef<number | null>(null);

  const isAdmin = hasRole('Admin') || isLocalBundledDeployment();

  const notify = useCallback(
    (message: string, type = 'info') => showToast?.(message, type),
    [showToast],
  );

  // Accept an activeRun application only if its server-authored version is at
  // least as fresh as what we've already applied, then record it. Stable
  // (reads a ref) so it is safe as a dependency. `undefined` version (older
  // servers / tests) is always accepted.
  const acceptStateVersion = useCallback((v?: number): boolean => {
    if (typeof v !== 'number') return true;
    if (v < appliedRunVersionRef.current) return false;
    appliedRunVersionRef.current = v;
    return true;
  }, []);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!projectId) {
        setState(null);
        return;
      }
      const proj = projectId;
      const gen = ++loadGenRef.current;
      const current = () => proj === projectRef.current && gen === loadGenRef.current;
      if (!opts.silent) setLoading(true);
      try {
        const res = (await api.getAutopilot(proj)) as AutopilotProjectStateWire;
        if (!current()) return; // project switched or superseded by a newer load
        // Apply the run only if this GET is at least as fresh as what's shown;
        // config always takes the latest read. This keeps a stale read (e.g. a
        // reconnect returning pre-Start state) from clobbering a newer applied
        // run, while a newer read supersedes stale mutations.
        const runFresh = acceptStateVersion(res.stateVersion);
        setState((prev) => ({
          config: res.config,
          activeRun: runFresh ? res.activeRun : (prev?.activeRun ?? null),
        }));
        setError(null);
        // Only repopulate the form when the operator has no unsaved edits, and
        // pin the base revision to what the form now reflects. A dirty form
        // keeps both its edits AND its older base revision.
        if (!dirtyRef.current) {
          setForm(formFromState(res));
          formBaseRevisionRef.current = res.config.revision;
          formLoadGenRef.current++;
        }
      } catch (e: any) {
        if (!current()) return;
        if (!opts.silent) setError(e?.message || 'Failed to load Autopilot state');
      } finally {
        if (current() && !opts.silent) setLoading(false);
      }
    },
    [projectId, acceptStateVersion],
  );

  // On project switch, drop the previous project's state/form immediately so
  // stale config never shows and mutations are blocked until the new project's
  // configuration has loaded (controls/setup render only once `view` exists).
  useEffect(() => {
    dirtyRef.current = false;
    loadGenRef.current++;
    projectGenRef.current++;
    busyRef.current = null;
    stopRef.current = null;
    appliedRunVersionRef.current = -1;
    formBaseRevisionRef.current = undefined;
    formLoadGenRef.current++;
    setState(null);
    setError(null);
    setBusy(null);
    setStopBusy(false);
    setForm(formFromState(null));
    load();
  }, [load]);

  // Refetch on WebSocket reconnect — state is server-authoritative, so a
  // dropped/restored socket never loses the run's progress.
  useEffect(() => {
    const onReconnected = () => load({ silent: true });
    window.addEventListener('agenthub:ws_reconnected', onReconnected);
    return () => window.removeEventListener('agenthub:ws_reconnected', onReconnected);
  }, [load]);

  const view = state ? deriveAutopilotView(state) : null;
  const active = Boolean(view?.controls.isActive);
  // An in-flight ordinary mutation disables every other mutation trigger, so
  // config/lifecycle requests can't overlap or arrive out of order. Stop is
  // tracked separately (`stopBusy`) and stays available.
  const mutating = busy !== null;

  // Poll while a run is active (no dedicated Autopilot WS event exists).
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => load({ silent: true }), ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const updateForm = (patch: Partial<FormState>) => {
    editSeqRef.current++;
    dirtyRef.current = true;
    setForm((prev) => ({ ...prev, ...patch }));
  };

  /**
   * Run a mutation, then reconcile local state with the server.
   *
   * The mutation's own response is authoritative, so we apply it immediately
   * (via `apply`) before the reconciling reload. That makes the reload
   * best-effort: if the follow-up GET fails, the UI still reflects the result
   * of the mutation (e.g. the newly started run) and the active-run poll keeps
   * retrying — the operator is never stranded on a stale snapshot.
   *
   * `resetForm` clears the dirty flag only when no newer edit landed while the
   * request was in flight, so a save never erases text typed during the PUT.
   */
  const runAction = async (
    key: string,
    fn: () => Promise<any>,
    successMsg: string,
    opts: {
      resetForm?: boolean;
      apply?: (
        res: any,
        prev: AutopilotProjectStateWire | null,
      ) => AutopilotProjectStateWire | null;
    } = {},
  ) => {
    // Block mutations until the current project's config has loaded.
    if (!projectId || !state) return;
    const isStop = key === 'stop';
    const slotRef = isStop ? stopRef : busyRef;
    // Serialize: refuse an ordinary mutation while one is in flight; refuse a
    // duplicate Stop while one is in flight. Stop and one ordinary mutation may
    // run concurrently, each with its own independent slot.
    if (slotRef.current !== null) return;
    // Identity for this operation: a unique token plus the project generation
    // it started under. Ownership is proven by these, never by (projectId,
    // key) — those recur across A → B → A and would let a stale completion
    // reclaim a newer operation's slot.
    const token = ++opSeqRef.current;
    const gen = projectGenRef.current;
    const proj = projectId;
    const editsAtStart = editSeqRef.current;
    slotRef.current = token;
    if (isStop) setStopBusy(true);
    else setBusy(key);
    // True only while this exact operation still owns its slot on the same
    // project generation.
    const owns = () =>
      slotRef.current === token && proj === projectRef.current && gen === projectGenRef.current;
    try {
      const res = await fn();
      // Discard the completion unless this operation still owns its slot — a
      // project switch or a newer same-key mutation supersedes it.
      if (!owns()) return;
      // Apply the mutation's authoritative response so the UI is correct even
      // if the reconciling reload below fails.
      if (opts.apply) setState((prev) => (prev ? opts.apply!(res, prev) : prev));
      // Reset the form only if the operator hasn't typed newer edits since the
      // request was submitted.
      if (opts.resetForm && editSeqRef.current === editsAtStart) dirtyRef.current = false;
      notify(successMsg, 'success');
      // Best-effort reconcile; failure is non-fatal (see doc comment).
      await load({ silent: true });
    } catch (e: any) {
      if (!owns()) return;
      notify(e?.message || 'Action failed', 'error');
      // Refresh so a rejected write (e.g. a revision conflict) re-reads the
      // current server state and revision for the next attempt.
      await load({ silent: true });
    } finally {
      // Release the slot only if this operation still owns it; a superseding
      // operation (after A → B → A, or a fresh Stop) must keep its own slot.
      if (slotRef.current === token) {
        slotRef.current = null;
        if (proj === projectRef.current && gen === projectGenRef.current) {
          if (isStop) setStopBusy(false);
          else setBusy(null);
        }
      }
    }
  };

  // Fold a run-snapshot mutation response (start/pause/resume/stop) into the
  // project-state shape — but only if the server's stateVersion is at least as
  // fresh as what we've already applied (ordering by server state, not arrival).
  const applyRunSnapshot = (
    res: any,
    prev: AutopilotProjectStateWire | null,
  ): AutopilotProjectStateWire | null => {
    if (!prev || !acceptStateVersion(res?.stateVersion)) return prev;
    return { ...prev, activeRun: res && typeof res === 'object' && res.run ? res : prev.activeRun };
  };

  const saveConfig = (enabled: boolean) => {
    // Reject invalid numeric limits client-side rather than letting them
    // silently change a safety-relevant limit (an invalid cost cap becoming
    // "no cap", or an invalid wall-time/timeout/retries/cycles being coerced to
    // a default the operator did not choose).
    const limitsCheck = validateAutopilotLimitsForm(form);
    if (!limitsCheck.ok) {
      notify(limitsCheck.message, 'error');
      return;
    }
    // The form lineage this save is persisting. If the form is reloaded from
    // the server (Refresh/load) before the PUT resolves, the completion must
    // NOT advance the base revision — the form now holds different content.
    const formGenAtStart = formLoadGenRef.current;
    return runAction(
      enabled ? 'enable' : 'save',
      () =>
        api.putAutopilotConfig(projectId, {
          ...buildConfigBody(form, enabled),
          // Optimistic-concurrency guard keyed to the revision the FORM was
          // built from (not the live state.config.revision, which a background
          // load may have advanced). The server rejects a stale write, so an
          // out-of-order PUT can't overwrite newer settings.
          expectedRevision: formBaseRevisionRef.current,
        }),
      enabled ? 'Autopilot enabled' : 'Configuration saved',
      {
        resetForm: true,
        apply: (res, prev) => {
          // Only pin the base to the written revision if the form still holds
          // exactly what this save persisted (no reload replaced it meanwhile).
          if (
            formLoadGenRef.current === formGenAtStart &&
            res &&
            typeof res === 'object' &&
            typeof res.revision === 'number'
          ) {
            formBaseRevisionRef.current = res.revision;
          }
          return prev && res && typeof res === 'object' ? { ...prev, config: res } : prev;
        },
      },
    );
  };

  const disable = () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Disable Autopilot? Any active run is stopped.')
    )
      return;
    runAction('disable', () => api.disableAutopilot(projectId), 'Autopilot disabled', {
      apply: (res, prev) => {
        if (!acceptStateVersion(res?.stateVersion)) return prev;
        return res && typeof res === 'object' && 'config' in res ? res : prev;
      },
    });
  };

  const stop = () => {
    if (typeof window !== 'undefined' && !window.confirm('Stop the active Autopilot run?')) return;
    runAction('stop', () => api.stopAutopilot(projectId), 'Stop requested', {
      apply: applyRunSnapshot,
    });
  };

  if (!projectId) {
    return (
      <div className="text-gray-400 text-sm" data-testid="autopilot-no-project">
        Select a project to configure Autopilot.
      </div>
    );
  }

  return (
    <div data-testid="autopilot-section" className="space-y-6">
      <div className="flex items-center gap-3">
        <Rocket className="text-purple-400" size={22} />
        <div>
          <h1 className="text-xl font-semibold text-gray-100 flex items-center gap-2">
            Experimental Autopilot
            <span className="text-[10px] uppercase tracking-wide bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
              Experimental
            </span>
          </h1>
          <p className="text-sm text-gray-400">
            Let the Hub plan, implement, deploy, verify and document small improvements against a
            dedicated local target, one cycle at a time.
          </p>
        </div>
        <button
          type="button"
          // Explicit reconcile: discard any unsaved edits and pull the latest
          // server config (advancing the pinned base revision). This is the
          // recovery path after a save is rejected as stale.
          onClick={() => {
            dirtyRef.current = false;
            load();
          }}
          className="ml-auto text-gray-400 hover:text-gray-200"
          title="Reload latest (discards unsaved edits)"
          data-testid="autopilot-refresh"
        >
          {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>

      {error && (
        <div
          className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2"
          data-testid="autopilot-error"
        >
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {view && view.run && (
        <div
          className="border border-gray-700 rounded-lg p-4 space-y-3 bg-gray-900/40"
          data-testid="autopilot-run"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-100">Current run</span>
            <span
              className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-200"
              data-testid="autopilot-run-state"
            >
              {view.run.controlStateLabel}
            </span>
            <span className="text-xs text-gray-400">
              Cycle {view.run.cycleNumber} · {view.run.stageLabel}
            </span>
          </div>
          {view.run.stopping && (
            <div className="text-xs text-amber-300" data-testid="autopilot-stopping">
              Cancellation in progress — this stays &ldquo;Stopping&rdquo; until in-flight work
              settles.
            </div>
          )}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <RunRow label="Selected improvement" value={view.run.selectedImprovement || '—'} />
            <RunRow
              label="Deployed target"
              value={
                view.run.deployedUrl ? (
                  <a
                    href={view.run.deployedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline"
                    data-testid="autopilot-deployed-url"
                  >
                    {view.run.deployedUrl}
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <RunRow label="Last verified revision" value={view.run.lastVerifiedShaShort} />
            <RunRow label="Usage" value={view.run.usageText} />
          </dl>
          {view.run.pauseReason && (
            <div className="text-xs text-amber-300" data-testid="autopilot-pause-reason">
              Paused: {view.run.pauseReason}
            </div>
          )}
          {view.run.failureReason && (
            <div className="text-xs text-red-300" data-testid="autopilot-failure-reason">
              Failed: {view.run.failureReason}
            </div>
          )}
          <EvidencePanel evidence={view.run.evidence} />
          <DocumentationPanel documentation={view.run.documentation} />
          <p className="text-xs text-gray-500" data-testid="autopilot-run-caveats">
            Evaluator scores reduce self-grading bias but do not prove product value or guarantee
            monotonic improvement. Recovery redeploys the last verified code artifact only. A code
            rollback is not a database rollback. See the operator runbook:{' '}
            <span className="text-gray-400">docs/guides/experimental-autopilot.md</span>.
          </p>
        </div>
      )}

      {view && (
        <div
          className="border border-gray-700 rounded-lg p-4 space-y-2"
          data-testid="autopilot-readiness"
        >
          <div className="text-sm font-semibold text-gray-100">Readiness</div>
          <ul className="space-y-1.5">
            {view.readiness.map((item) => (
              <li
                key={item.key}
                className="flex items-start gap-2 text-sm"
                data-testid={`autopilot-readiness-${item.key}`}
              >
                {item.ok ? (
                  <Check size={16} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <X size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                )}
                <span className="text-gray-200">
                  {item.label}
                  <span className="text-gray-500"> — {item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Lifecycle controls */}
      {view && isAdmin && (
        <div className="flex flex-wrap gap-2" data-testid="autopilot-controls">
          <ActionBtn
            testid="autopilot-start"
            show={view.controls.canStart}
            busy={busy === 'start'}
            disabled={mutating}
            onClick={() =>
              runAction('start', () => api.startAutopilot(projectId), 'Autopilot started', {
                apply: applyRunSnapshot,
              })
            }
            icon={<Play size={14} />}
            label="Start"
            variant="primary"
          />
          <ActionBtn
            testid="autopilot-pause"
            show={view.controls.canPause}
            busy={busy === 'pause'}
            disabled={mutating}
            onClick={() =>
              runAction('pause', () => api.pauseAutopilot(projectId), 'Pause requested', {
                apply: applyRunSnapshot,
              })
            }
            icon={<Pause size={14} />}
            label="Pause"
          />
          <ActionBtn
            testid="autopilot-resume"
            show={view.controls.canResume}
            busy={busy === 'resume'}
            disabled={mutating}
            onClick={() =>
              runAction('resume', () => api.resumeAutopilot(projectId), 'Resumed', {
                apply: applyRunSnapshot,
              })
            }
            icon={<Play size={14} />}
            label="Resume"
          />
          {view.controls.isActive && (
            <button
              type="button"
              disabled={!view.controls.canStop || stopBusy}
              onClick={stop}
              data-testid="autopilot-stop"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-red-600/80 hover:bg-red-600 text-white disabled:opacity-50"
            >
              {view.controls.stopping || stopBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Stopping…
                </>
              ) : (
                <>
                  <Square size={14} /> Stop
                </>
              )}
            </button>
          )}
          <ActionBtn
            testid="autopilot-disable"
            show={view.controls.canDisable}
            busy={busy === 'disable'}
            disabled={mutating}
            onClick={disable}
            label="Disable Autopilot"
            variant="ghost"
          />
        </div>
      )}

      {/* Setup form (admin only) */}
      {view && isAdmin && (
        <div
          className="border border-gray-700 rounded-lg p-4 space-y-4"
          data-testid="autopilot-setup"
        >
          <div className="text-sm font-semibold text-gray-100">Setup</div>
          <Field label="Product brief">
            <textarea
              value={form.brief}
              onChange={(e) => updateForm({ brief: e.target.value })}
              rows={3}
              data-testid="autopilot-brief"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100"
              placeholder="What should the experiment build and keep improving?"
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Target id (deploy.yaml env)">
              <TextInput
                value={form.targetId}
                onChange={(v) => updateForm({ targetId: v })}
                testid="autopilot-target-id"
                placeholder="local"
              />
            </Field>
            <Field label="Loopback origin">
              <TextInput
                value={form.origin}
                onChange={(v) => updateForm({ origin: v })}
                testid="autopilot-origin"
                placeholder="http://127.0.0.1:8080"
              />
            </Field>
            <Field label="Readiness probe URL">
              <TextInput
                value={form.readinessProbeUrl}
                onChange={(v) => updateForm({ readinessProbeUrl: v })}
                testid="autopilot-readiness-url"
                placeholder="http://127.0.0.1:8080/health"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Cycle mode">
              <select
                value={form.cycleMode}
                onChange={(e) =>
                  updateForm({ cycleMode: e.target.value as FormState['cycleMode'] })
                }
                data-testid="autopilot-cycle-mode"
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100"
              >
                <option value="continuous">Continuous</option>
                <option value="finite">Finite</option>
              </select>
            </Field>
            {form.cycleMode === 'finite' && (
              <Field label="Max cycles">
                <TextInput
                  value={form.maxCycles}
                  onChange={(v) => updateForm({ maxCycles: v })}
                  testid="autopilot-max-cycles"
                  type="number"
                />
              </Field>
            )}
            <Field label="Wall-time budget (hours)">
              <TextInput
                value={form.maxWallTimeHours}
                onChange={(v) => updateForm({ maxWallTimeHours: v })}
                testid="autopilot-wall-time"
                type="number"
              />
            </Field>
            <Field label="Per-stage timeout (minutes)">
              <TextInput
                value={form.maxStageTimeoutMinutes}
                onChange={(v) => updateForm({ maxStageTimeoutMinutes: v })}
                testid="autopilot-stage-timeout"
                type="number"
              />
            </Field>
            <Field label="Retries per stage (0-2)">
              <TextInput
                value={form.maxRetriesPerStage}
                onChange={(v) => updateForm({ maxRetriesPerStage: v })}
                testid="autopilot-retries"
                type="number"
              />
            </Field>
            <Field label="Cost cap (USD, optional)">
              <TextInput
                value={form.maxCostUsd}
                onChange={(v) => updateForm({ maxCostUsd: v })}
                testid="autopilot-cost-cap"
                type="number"
              />
            </Field>
          </div>
          <Field label="Credential owner (user id)">
            <TextInput
              value={form.credentialOwnerUserId}
              onChange={(v) => updateForm({ credentialOwnerUserId: v })}
              testid="autopilot-credential-owner"
              placeholder="user id whose scoped credentials the worker runs under"
            />
          </Field>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={mutating}
              onClick={() => saveConfig(state?.config.enabled ?? false)}
              data-testid="autopilot-save-config"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-100 disabled:opacity-50"
            >
              {(busy === 'save' || busy === 'enable') && (
                <Loader2 size={14} className="animate-spin" />
              )}
              Save configuration
            </button>
            {!view.enabled && (
              <button
                type="button"
                disabled={mutating}
                onClick={() => saveConfig(true)}
                data-testid="autopilot-enable-toggle"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
              >
                {busy === 'enable' && <Loader2 size={14} className="animate-spin" />}
                Enable Autopilot
              </button>
            )}
          </div>
        </div>
      )}

      {view && !isAdmin && (
        <div className="text-sm text-gray-400" data-testid="autopilot-readonly">
          You have read-only access. An Admin manages the Autopilot configuration and run controls.
        </div>
      )}
    </div>
  );
}

function RunRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-gray-500 text-xs">{label}</dt>
      <dd className="text-gray-100">{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-gray-400">{label}</span>
      {children}
    </label>
  );
}

const VERDICT_STYLES: Record<AutopilotEvidenceView['verdict'], string> = {
  passed: 'bg-emerald-500/20 text-emerald-300',
  failed: 'bg-red-500/20 text-red-300',
  pending: 'bg-gray-700 text-gray-300',
};

function EvidencePanel({ evidence }: { evidence: AutopilotEvidenceView | null }) {
  if (!evidence) {
    return (
      <div className="text-xs text-gray-500" data-testid="autopilot-evidence-empty">
        Verification evidence: none captured yet.
      </div>
    );
  }
  return (
    <div className="border-t border-gray-800 pt-3 space-y-2" data-testid="autopilot-evidence">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-200">Verification evidence</span>
        <span
          className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${VERDICT_STYLES[evidence.verdict]}`}
          data-testid="autopilot-evidence-verdict"
        >
          {evidence.verdict}
        </span>
      </div>
      {evidence.verdict === 'failed' && (evidence.failureReason || evidence.failureDetail) && (
        <div className="text-xs text-red-300" data-testid="autopilot-evidence-failure">
          {evidence.failureReason ? `${evidence.failureReason}: ` : ''}
          {evidence.failureDetail || 'Verification failed.'}
        </div>
      )}
      <div className="text-xs text-gray-400">
        {evidence.observedSha
          ? `Observed ${evidence.observedSha.slice(0, 10)}`
          : 'Revision unknown'}
        {evidence.origin ? ` at ${evidence.origin}` : ''}
        {evidence.healthOk != null && ` · health ${evidence.healthOk ? 'ok' : 'failing'}`}
        {evidence.usedPreview && ' · used preview (not the live target)'}
      </div>
      {evidence.criteria.length > 0 && (
        <ul className="space-y-1">
          {evidence.criteria.map((c, i) => (
            <li
              key={`${c.criterionId}-${i}`}
              className="text-xs text-gray-300 flex items-start gap-1.5"
              data-testid={`autopilot-evidence-criterion-${c.criterionId || i}`}
            >
              {c.passed ? (
                <Check size={13} className="text-emerald-400 mt-0.5 flex-shrink-0" />
              ) : (
                <X size={13} className="text-red-400 mt-0.5 flex-shrink-0" />
              )}
              <span>
                <span className="text-gray-200">{c.criterionId || 'criterion'}</span>
                {c.observed ? ` — ${c.observed}` : ''}
                {c.artifactRef && <span className="text-gray-500"> ({c.artifactRef})</span>}
                {c.claimedWithoutEvidence && (
                  <span className="text-amber-300"> · claimed without evidence</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentationPanel({
  documentation,
}: {
  documentation: AutopilotDocumentationView | null;
}) {
  if (!documentation) {
    return (
      <div className="text-xs text-gray-500" data-testid="autopilot-documentation-empty">
        Documentation: none recorded yet.
      </div>
    );
  }
  const d = documentation;
  return (
    <div className="border-t border-gray-800 pt-3 space-y-2" data-testid="autopilot-documentation">
      <div className="text-xs font-semibold text-gray-200">Documentation</div>
      {d.expectedBenefit && (
        <div className="text-xs text-gray-300">
          <span className="text-gray-500">Expected benefit:</span> {d.expectedBenefit}
        </div>
      )}
      {d.actualChange && (
        <div className="text-xs text-gray-300">
          <span className="text-gray-500">Actual change:</span> {d.actualChange}
        </div>
      )}
      {d.outcome && (
        <div className="text-xs text-gray-300">
          <span className="text-gray-500">Outcome:</span> {d.outcome}
        </div>
      )}
      {d.nextAction && (
        <div className="text-xs text-gray-300">
          <span className="text-gray-500">Next:</span> {d.nextAction}
        </div>
      )}
      {d.decisions.length > 0 && (
        <ul className="text-xs text-gray-300 space-y-0.5">
          {d.decisions.map((dec) => (
            <li key={dec.key}>
              <span className="text-gray-500">{dec.key}:</span> {dec.decision}
            </li>
          ))}
        </ul>
      )}
      {d.links.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="autopilot-doc-links">
          {d.links.map((l) => (
            <span key={l.label} className="text-gray-400">
              {l.label}:{' '}
              {l.href ? (
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  {l.value}
                </a>
              ) : (
                <span className="text-gray-200">{l.value}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {(d.journalSlug || d.wikiSlugs.length > 0) && (
        <div className="text-xs text-gray-500">
          Pages: {[d.journalSlug, ...d.wikiSlugs].filter(Boolean).join(', ')}
        </div>
      )}
      {d.evidenceRefs.length > 0 && (
        <div className="text-xs text-gray-500">
          Artifacts: {d.evidenceRefs.map((e) => `${e.kind}:${e.ref}`).join(', ')}
        </div>
      )}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  testid,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testid}
      placeholder={placeholder}
      className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100"
    />
  );
}

function ActionBtn({
  testid,
  show,
  busy,
  disabled,
  onClick,
  icon,
  label,
  variant = 'default',
}: {
  testid: string;
  show: boolean;
  busy: boolean;
  /** Disabled because another mutation is in flight (spinner stays on `busy`). */
  disabled?: boolean;
  onClick: () => void;
  icon?: ReactNode;
  label: string;
  variant?: 'primary' | 'default' | 'ghost';
}) {
  if (!show) return null;
  const cls =
    variant === 'primary'
      ? 'bg-purple-600 hover:bg-purple-500 text-white'
      : variant === 'ghost'
        ? 'bg-transparent border border-gray-600 text-gray-300 hover:bg-gray-800'
        : 'bg-gray-700 hover:bg-gray-600 text-gray-100';
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      data-testid={testid}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm disabled:opacity-50 ${cls}`}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
