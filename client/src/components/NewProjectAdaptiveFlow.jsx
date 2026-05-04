import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Code2, Kanban, X } from 'lucide-react';
import AdaptiveQuestionnaire from './AdaptiveQuestionnaire.jsx';
import ProvisioningStatus from './ProvisioningStatus.jsx';
import PostScaffoldAudit from './PostScaffoldAudit.jsx';
import ProjectLandingHandoff from './ProjectLandingHandoff.jsx';
import {
  provisionProject as defaultProvision,
  subscribeProvisioningEvents as defaultSubscribe,
} from '../utils/provisioningClient.js';
import {
  createWorkflowProject as defaultCreateWorkflowProject,
  slugifyProjectId,
} from '../utils/workflowProjectClient.js';

/**
 * NewProjectAdaptiveFlow — stitches the project-type picker, the
 * questionnaire, the live provisioning status view, the post-scaffold
 * audit, and the workflow (non-code) form.
 *
 * Sub-views driven by local state:
 *   0. `type-picker` — render <ProjectTypePicker /> so the user chooses
 *      between a code project (full scaffold path) and a workflow /
 *      non-code project (kanban + wiki + agents only). Picking "code"
 *      enters the existing flow at `questionnaire`; picking "workflow"
 *      enters the `workflow-form` view.
 *   1. `questionnaire` — render <AdaptiveQuestionnaire />. On submit we
 *      POST the payload to the provisioning endpoint, open the event
 *      stream, and transition to...
 *   2. `provisioning` — render <ProvisioningStatus /> with the event
 *      buffer reduced in real time. When a terminal success event lands
 *      and the user clicks "Continue", we transition to...
 *   3. `audit` — render <PostScaffoldAudit /> (Act IV): readiness score,
 *      findings, gaps, plus an agent-roster picker the user confirms to
 *      persist tracks on the new project record. On confirm we transition to...
 *   4. `landing` — render <ProjectLandingHandoff /> (Act V): summary card
 *      (repo / stack / integrations), audit highlights, assigned roster
 *      with per-row "Chat" actions, and a starter-task next-steps panel.
 *      Every outbound action funnels through `onProjectCreated` so the
 *      host app can decide how to route (open chat, open kanban, etc.).
 *  5. `workflow-form` — render <WorkflowProjectForm /> for non-code
 *      projects. On submit we POST `/api/projects` with `mode:'workflow'`
 *      and signal `onProjectCreated({projectId, action:'task'})` so the
 *      host lands on the new project's kanban view.
 *
 * The `provision`, `subscribe`, and `createWorkflowProject` deps are
 * injectable so tests can drive the flow without a real server.
 *
 * GitHub-integration detection:
 *   If the questionnaire payload's `integrations` array includes 'github'
 *   (or is the idk sentinel — defer to agent default), the ProvisioningStatus
 *   renders the full phase list with gh-* phases. If the user explicitly
 *   omitted GitHub, the gh-* phases are skipped and the UI surfaces a
 *   local-only scaffold.
 */
export default function NewProjectAdaptiveFlow({
  onClose,
  onProjectCreated,
  provision = defaultProvision,
  subscribe = defaultSubscribe,
  createWorkflowProject = defaultCreateWorkflowProject,
  /** Provisioning watchdog window (ms) — how long the stream can stay
   * silent before we synthesize a terminal failure. Override via prop for
   * E2E tests; subscribe() also honours VITE_PROVISIONING_WATCHDOG_MS. */
  watchdogMs,
  /** Test hook: skip the type picker and start at the named view. */
  initialView = 'type-picker',
}) {
  const [view, setView] = useState(initialView);
  const [events, setEvents] = useState([]);
  const [withGithub, setWithGithub] = useState(true);
  const [launchError, setLaunchError] = useState(null);
  const [createdProjectId, setCreatedProjectId] = useState(null);
  const [questionnairePayload, setQuestionnairePayload] = useState(null);
  const [landingContext, setLandingContext] = useState(null);
  const streamHandleRef = useRef(null);
  const currentPayloadRef = useRef(null);

  // Tear down the event stream on unmount so we don't leak sockets.
  useEffect(() => {
    return () => {
      streamHandleRef.current?.close?.();
    };
  }, []);

  const start = useCallback(
    async (payload) => {
      setLaunchError(null);
      setEvents([]);
      setCreatedProjectId(null);
      setWithGithub(inferWithGithub(payload));
      setView('provisioning');
      currentPayloadRef.current = payload;
      setQuestionnairePayload(payload);
      setLandingContext(null);
      try {
        const { wsUrl, projectId } = await provision(payload);
        if (projectId) setCreatedProjectId(projectId);
        const handle = subscribe(wsUrl, {
          onEvent: (ev) => setEvents((prev) => [...prev, ev]),
          onClose: () => {
            // The terminal `done` event in the stream drives the overall
            // status. The subscribe helper owns the reconnect + watchdog
            // behavior — if it can't recover, it synthesizes a terminal
            // `done` with a STREAM_STALLED / STREAM_DROPPED error code,
            // which ProvisioningStatus renders as a failure card with
            // retry. Nothing extra needed here.
          },
          onError: (err) => {
            setLaunchError(
              err instanceof Error ? err.message : 'Unknown provisioning stream error',
            );
          },
          ...(typeof watchdogMs === 'number' ? { watchdogMs } : {}),
        });
        streamHandleRef.current = handle;
      } catch (err) {
        setLaunchError(err instanceof Error ? err.message : String(err));
        // Synthesize a failure event so ProvisioningStatus renders the
        // failure card rather than sitting stuck on "Waiting to start".
        setEvents([
          {
            type: 'done',
            error: {
              code: -2,
              message: err instanceof Error ? err.message : String(err),
            },
          },
        ]);
      }
    },
    [provision, subscribe, watchdogMs],
  );

  const handleRetry = useCallback(() => {
    const payload = currentPayloadRef.current;
    streamHandleRef.current?.close?.();
    if (payload) start(payload);
  }, [start]);

  const handleClose = useCallback(() => {
    streamHandleRef.current?.close?.();
    onClose?.();
  }, [onClose]);

  const handleOpenRepo = useCallback(
    (repoUrl) => {
      onProjectCreated?.({ repoUrl, projectId: createdProjectId });
    },
    [onProjectCreated, createdProjectId],
  );

  // After a successful provisioning run, the success card's primary action
  // transitions the flow into Act IV (audit + roster). We extract the
  // terminal `done` event so we only advance on clean completion — the
  // partial / failed paths keep the user on the provisioning view with
  // their respective recovery affordances.
  const terminalDone = useMemo(() => events.find((e) => e && e.type === 'done'), [events]);
  const provisioningSucceeded = terminalDone && !terminalDone.error;
  const repoUrl = terminalDone && !terminalDone.error ? terminalDone.repoUrl || null : null;

  const handleContinueToAudit = useCallback(() => {
    // The provisioning socket has already emitted its terminal `done`
    // event — tear it down eagerly so Act IV doesn't inherit an open
    // socket the server will reap anyway.
    streamHandleRef.current?.close?.();
    setView('audit');
  }, []);

  // Act IV → Act V handoff. The audit component passes its rendered report
  // + agent list + roster as a second arg so the landing can render the
  // summary without refetching. The skip path still bypasses the landing
  // (user explicitly opted out of finishing the flow in-wizard).
  const handleAuditConfirmed = useCallback((saved, extras) => {
    const tracks = Array.isArray(saved?.tracks) ? saved.tracks : [];
    // Prefer the UI-normalized roster rows (include `label` + `trackId`)
    // over the compact server payload so the landing renders properly
    // with just the information Act IV already had in memory.
    const rosterRows =
      Array.isArray(extras?.roster) && extras.roster.length > 0
        ? extras.roster
        : tracks.map((t) => ({
            trackId: t.id,
            label: t.label || t.id,
            agentId: t.agentId || null,
            custom: !!t.custom,
          }));
    setLandingContext({
      roster: rosterRows,
      report: extras?.report || null,
      agents: Array.isArray(extras?.agents) ? extras.agents : [],
      savedTracks: tracks,
    });
    setView('landing');
  }, []);

  const handleAuditSkip = useCallback(() => {
    // Skip is an explicit exit — don't create a landing context. Emit the
    // "project created" signal with whatever we have so the host can
    // still refresh its project list / sidebar. The host's onProjectCreated
    // handler routes the view; we don't call onClose to avoid clobbering.
    if (createdProjectId) {
      onProjectCreated?.({ projectId: createdProjectId, skipped: true });
    } else {
      onClose?.();
    }
  }, [onClose, onProjectCreated, createdProjectId]);

  // Landing action handlers — every path funnels through `onProjectCreated`
  // with a payload the host can route on (e.g. open a chat, open the
  // kanban). `onProjectCreated` is the terminal signal; we intentionally
  // do NOT call `onClose` here because the host's `onProjectCreated`
  // handler already manages the view transition, and calling both in the
  // same tick would let `onClose`'s setState clobber the routing.
  const handleLandingOpenProject = useCallback(
    ({ projectId, repoUrl: outRepoUrl }) => {
      onProjectCreated?.({
        projectId: projectId || createdProjectId,
        repoUrl: outRepoUrl || null,
        action: 'open',
      });
    },
    [onProjectCreated, createdProjectId],
  );

  const handleLandingStartChat = useCallback(
    ({ projectId, agentId, trackId }) => {
      if (!agentId) return;
      onProjectCreated?.({
        projectId: projectId || createdProjectId,
        agentId,
        trackId: trackId || null,
        action: 'chat',
      });
    },
    [onProjectCreated, createdProjectId],
  );

  const handleLandingStarterTask = useCallback(
    ({ projectId, task }) => {
      onProjectCreated?.({
        projectId: projectId || createdProjectId,
        action: 'task',
        task: task || null,
      });
    },
    [onProjectCreated, createdProjectId],
  );

  const handlePickType = useCallback((type) => {
    if (type === 'workflow') {
      setView('workflow-form');
      return;
    }
    // Default: code path — drop into the existing adaptive questionnaire.
    setView('questionnaire');
  }, []);

  // Workflow-form submit: POST /api/projects with mode:'workflow' and
  // route the host to the new project's kanban (action:'task' is the
  // existing host signal that transitions to `kanban:<projectId>`).
  const handleWorkflowSubmit = useCallback(
    async ({ name, description, color }) => {
      const project = await createWorkflowProject({ name, description, color });
      const projectId = project?.id || slugifyProjectId(name);
      setCreatedProjectId(projectId);
      onProjectCreated?.({
        projectId,
        action: 'task',
        mode: 'workflow',
      });
    },
    [createWorkflowProject, onProjectCreated],
  );

  if (view === 'type-picker') {
    return <ProjectTypePicker onPick={handlePickType} onClose={onClose} />;
  }

  if (view === 'workflow-form') {
    return (
      <WorkflowProjectForm
        onSubmit={handleWorkflowSubmit}
        onBack={() => setView('type-picker')}
        onClose={onClose}
      />
    );
  }

  if (view === 'questionnaire') {
    // Back from step 1 of the questionnaire returns the user to the
    // type picker — keeps the picker reachable without a viewport-level
    // close button on the questionnaire.
    return <AdaptiveQuestionnaire onSubmit={start} onClose={() => setView('type-picker')} />;
  }

  if (view === 'audit') {
    return (
      <PostScaffoldAudit
        projectId={createdProjectId}
        onConfirmed={handleAuditConfirmed}
        onSkip={handleAuditSkip}
      />
    );
  }

  if (view === 'landing') {
    return (
      <ProjectLandingHandoff
        projectId={createdProjectId}
        projectName={questionnairePayload?.name}
        repoUrl={repoUrl}
        payload={questionnairePayload}
        report={landingContext?.report || null}
        roster={landingContext?.roster || []}
        agents={landingContext?.agents || []}
        onOpenProject={handleLandingOpenProject}
        onStartChat={handleLandingStartChat}
        onOpenStarterTask={handleLandingStarterTask}
        onClose={handleClose}
      />
    );
  }

  return (
    <div className="flex flex-col w-full h-full" data-testid="new-project-adaptive-flow">
      {launchError && !events.some((e) => e.type === 'done') && (
        <div
          className="shrink-0 bg-red-900/60 border-b border-red-700 text-red-100 text-sm px-4 py-2"
          data-testid="np-launch-error"
        >
          Failed to start provisioning: {launchError}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ProvisioningStatus
          events={events}
          withGithub={withGithub}
          onRetry={handleRetry}
          onClose={provisioningSucceeded ? handleContinueToAudit : handleClose}
          onOpenRepo={handleOpenRepo}
        />
      </div>
    </div>
  );
}

/**
 * Determine whether the ProvisioningStatus UI should render the gh-*
 * phases. `idk` means "defer to agent default" — we keep gh enabled so
 * the status row stays visible if the agent chooses to publish.
 */
export function inferWithGithub(payload) {
  if (!payload) return true;
  const { integrations } = payload;
  if (integrations === 'idk' || integrations == null) return true;
  if (Array.isArray(integrations)) return integrations.includes('github');
  return true;
}

/* -------------------------------------------------------------------------- */
/* Project type picker — Step 0 of the New Project flow.                      */
/* -------------------------------------------------------------------------- */

/**
 * Top-level picker that lets the user choose between a code project (the
 * existing adaptive scaffolding flow) and a workflow / non-code project
 * (kanban + wiki + agents only). Exported for tests.
 */
export function ProjectTypePicker({ onPick, onClose }) {
  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="project-type-picker"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
        <h1 className="min-w-0 flex-1 text-base font-semibold text-white">New Project</h1>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            data-testid="ptp-close"
            aria-label="Close"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <X size={16} className="text-gray-400" />
            Close
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-white">What kind of project?</h2>
            <p className="mt-1 text-sm text-gray-400">
              Pick a code project to scaffold a real repo with stack + integrations, or a workflow
              project for pure kanban / wiki / agents with no repo.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onPick('code')}
              data-testid="ptp-code"
              className="group flex h-full flex-col items-start gap-3 rounded-xl border border-gray-700 bg-gray-900/60 p-5 text-left transition-colors hover:border-emerald-500 hover:bg-emerald-500/5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-900/40 text-emerald-300 group-hover:bg-emerald-500/20">
                <Code2 size={20} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-white">Code project</div>
                <p className="mt-1 text-xs text-gray-400">
                  Scaffold a new repo: pick a stack, integrations, auth, and (optionally) push to
                  GitHub. Worktrees + PR flow are on.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onPick('workflow')}
              data-testid="ptp-workflow"
              className="group flex h-full flex-col items-start gap-3 rounded-xl border border-gray-700 bg-gray-900/60 p-5 text-left transition-colors hover:border-indigo-500 hover:bg-indigo-500/5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-900/40 text-indigo-300 group-hover:bg-indigo-500/20">
                <Kanban size={20} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-white">Workflow / non-code</div>
                <p className="mt-1 text-xs text-gray-400">
                  Research, ops, planning, knowledge management. Kanban + wiki + agents + sessions.
                  No repo, no worktrees, no PR flow.
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Workflow project form — minimal name/description/color collector.          */
/* -------------------------------------------------------------------------- */

/** Color swatches offered to workflow projects. Mirrors the palette used by
 *  the existing project list so colors stay consistent across surfaces. */
export const WORKFLOW_COLOR_OPTIONS = [
  { value: '#6B7280', label: 'Gray' },
  { value: '#3B82F6', label: 'Blue' },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#10B981', label: 'Green' },
  { value: '#F59E0B', label: 'Amber' },
  { value: '#EF4444', label: 'Red' },
  { value: '#EC4899', label: 'Pink' },
];

/**
 * Form for the workflow / non-code path. Collects only what's required to
 * land the user on a usable project (name + optional description/color),
 * then calls `onSubmit({name, description, color})` and surfaces any
 * server error inline. Exported for tests.
 */
export function WorkflowProjectForm({ onSubmit, onBack, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(WORKFLOW_COLOR_OPTIONS[0].value);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = name.trim();
  const slugPreview = useMemo(() => slugifyProjectId(trimmed), [trimmed]);
  const canSubmit = trimmed.length > 0 && slugPreview.length >= 3 && !submitting;

  const handleSubmit = useCallback(
    async (e) => {
      if (e?.preventDefault) e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        await onSubmit?.({ name: trimmed, description: description.trim(), color });
        // Don't reset state — onSubmit's host handler unmounts us by
        // routing to the new project's kanban view.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(false);
      }
    },
    [canSubmit, color, description, onSubmit, trimmed],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="workflow-project-form"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          data-testid="wpf-back"
          aria-label="Back"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
        >
          <ArrowLeft size={16} className="text-gray-400" />
          Back
        </button>
        <h1 className="min-w-0 flex-1 text-base font-semibold text-white">New Workflow Project</h1>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            data-testid="wpf-close"
            aria-label="Close"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <X size={16} className="text-gray-400" />
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <p className="text-sm text-gray-400">
            Workflow projects skip the code scaffolding step. You&apos;ll get kanban, wiki, agents,
            sessions, heartbeats, and crons — no repo, no worktrees.
          </p>

          <div>
            <label
              htmlFor="wpf-name-input"
              className="block text-xs font-medium text-gray-400 mb-1"
            >
              Project name
            </label>
            <input
              id="wpf-name-input"
              type="text"
              value={name}
              autoFocus
              placeholder="e.g. Q3 Research"
              onChange={(e) => setName(e.target.value)}
              data-testid="wpf-name-input"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
            {trimmed && slugPreview && (
              <p className="mt-1 text-xs text-gray-500" data-testid="wpf-slug-preview">
                Project id:{' '}
                <code className="text-emerald-300 bg-gray-900 px-1 py-0.5 rounded">
                  {slugPreview}
                </code>
              </p>
            )}
            {trimmed && !slugPreview && (
              <p className="mt-1 text-xs text-red-400" role="alert">
                Project name must contain letters or digits.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="wpf-description-input"
              className="block text-xs font-medium text-gray-400 mb-1"
            >
              Description <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              id="wpf-description-input"
              value={description}
              rows={3}
              placeholder="What is this project for? (kept for your own reference)"
              onChange={(e) => setDescription(e.target.value)}
              data-testid="wpf-description-input"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-y transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Color</label>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2" data-testid="wpf-color-options">
              {WORKFLOW_COLOR_OPTIONS.map((opt) => {
                const selected = color === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setColor(opt.value)}
                    aria-pressed={selected}
                    aria-label={opt.label}
                    title={opt.label}
                    data-testid={`wpf-color-${opt.value.replace('#', '').toLowerCase()}`}
                    className={`flex items-center justify-center h-9 rounded-lg border transition-colors ${
                      selected ? 'border-white' : 'border-gray-700 hover:border-gray-500'
                    }`}
                    style={{ backgroundColor: opt.value }}
                  >
                    {selected && <Check size={14} className="text-white drop-shadow" />}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div
              role="alert"
              data-testid="wpf-error"
              className="rounded-lg border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-100"
            >
              {error}
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-gray-800 bg-gray-900/90 px-4 py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            data-testid="wpf-submit"
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating…' : 'Create Project'}
          </button>
        </div>
      </footer>
    </form>
  );
}
