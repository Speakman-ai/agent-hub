import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Code2, FolderGit2, Kanban, X } from 'lucide-react';
import AdaptiveQuestionnaire from './AdaptiveQuestionnaire';
import ProvisioningStatus from './ProvisioningStatus';
import {
  provisionProject as defaultProvision,
  subscribeProvisioningEvents as defaultSubscribe,
} from '../utils/provisioningClient';
import {
  createWorkflowProject as defaultCreateWorkflowProject,
  slugifyProjectId,
} from '../utils/workflowProjectClient';

/**
 * NewProjectAdaptiveFlow — stitches the project-type picker, the
 * questionnaire, the live provisioning status view, and the workflow
 * (non-code) form.
 *
 * Sub-views driven by local state:
 *   0. `type-picker` — render <ProjectTypePicker /> so the user chooses
 *      among creating a new code repo (scaffold questionnaire), importing
 *      an existing repo (host swaps to OpenProjectWizard), or a workflow /
 *      non-code project (kanban + wiki + agents only). Picking "code"
 *      enters `questionnaire`; "import" signals `onProjectCreated({ action:
 *      'import' })`; "workflow" enters `workflow-form`.
 *   1. `questionnaire` — render <AdaptiveQuestionnaire />. On submit we
 *      POST the payload to the provisioning endpoint, open the event
 *      stream, and transition to...
 *   2. `provisioning` — render <ProvisioningStatus /> with the event
 *      buffer reduced in real time. When the first build session starts,
 *      we signal `onProjectCreated({ action: 'session', sessionId, … })`
 *      so the host opens that chat — no landing / next-steps picker.
 *   3. `workflow-form` — render <WorkflowProjectForm /> for non-code
 *      projects. On submit we POST `/api/projects` with `mode:'workflow'`
 *      and signal `onProjectCreated({projectId, action:'task'})` so the
 *      host lands on the new project's kanban view.
 *
 * The `provision`, `subscribe`, and `createWorkflowProject` deps are
 * injectable so tests can drive the flow without a real server.
 *
 * GitHub-integration detection:
 *   The hosting answer is the source of truth. Agent Hub-hosted projects
 *   skip the gh-* phases. Explicit GitHub-only hosting shows them.
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
  /** How long to wait after a terminal (non-failed) provisioning `done`
   * for the `initial_build_started` handoff before revealing a manual
   * escape. Guards against a missed/dropped broadcast or a first-build
   * creation that failed after `done`. Override via prop for tests. */
  buildHandoffTimeoutMs = 20000,
  /** Test hook: skip the type picker and start at the named view. */
  initialView = 'type-picker',
}: any) {
  const [view, setView] = useState(initialView);
  const [events, setEvents] = useState<any[]>([]);
  const [withGithub, setWithGithub] = useState(true);
  const [withToolchain, setWithToolchain] = useState(false);
  const [launchError, setLaunchError] = useState<any>(null);
  const [createdProjectId, setCreatedProjectId] = useState<any>(null);
  // Flips true when the first-build handoff hasn't arrived within
  // `buildHandoffTimeoutMs` of a terminal (non-failed) `done`, so the
  // success/partial card can offer a manual "Open project" escape instead
  // of hanging forever on "Opening the first build session…".
  const [buildHandoffTimedOut, setBuildHandoffTimedOut] = useState(false);
  const streamHandleRef = useRef<any>(null);
  const currentPayloadRef = useRef<any>(null);
  const createdProjectIdRef = useRef<any>(null);
  const openedBuildSessionRef = useRef(false);

  // Tear down the event stream on unmount so we don't leak sockets.
  useEffect(() => {
    return () => {
      streamHandleRef.current?.close?.();
    };
  }, []);

  const openBuildSession = useCallback(
    (detail: any) => {
      if (openedBuildSessionRef.current) return;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId : '';
      if (!sessionId) return;
      const projectId = createdProjectIdRef.current;
      if (!projectId || detail?.projectId !== projectId) return;
      openedBuildSessionRef.current = true;
      streamHandleRef.current?.close?.();
      onProjectCreated?.({
        action: 'session',
        projectId: projectId || detail.projectId || null,
        sessionId,
        agentId: detail.agentId || null,
      });
    },
    [onProjectCreated],
  );

  // First-build kickoff broadcasts on the main app WebSocket after the
  // provisioning job's `done` event. App.jsx re-dispatches it as
  // `initial-build-ws` so this overlay can open the session without a
  // landing / next-steps picker.
  useEffect(() => {
    const handler = (e: any) => {
      const data = e.detail;
      if (!data || data.type !== 'initial_build_started') return;
      openBuildSession(data);
    };
    window.addEventListener('initial-build-ws', handler);
    return () => window.removeEventListener('initial-build-ws', handler);
  }, [openBuildSession]);

  const start = useCallback(
    async (payload: any) => {
      setLaunchError(null);
      setEvents([]);
      setCreatedProjectId(null);
      createdProjectIdRef.current = null;
      openedBuildSessionRef.current = false;
      setBuildHandoffTimedOut(false);
      setWithGithub(inferWithGithub(payload));
      setWithToolchain(inferWithToolchain(payload));
      setView('provisioning');
      currentPayloadRef.current = payload;
      try {
        const { wsUrl, projectId } = await provision(payload);
        if (projectId) {
          createdProjectIdRef.current = projectId;
          setCreatedProjectId(projectId);
        }
        const handle = subscribe(wsUrl, {
          onEvent: (ev: any) => setEvents((prev: any) => [...prev, ev]),
          onClose: () => {
            // The terminal `done` event in the stream drives the overall
            // status. The subscribe helper owns the reconnect + watchdog
            // behavior — if it can't recover, it synthesizes a terminal
            // `done` with a STREAM_STALLED / STREAM_DROPPED error code,
            // which ProvisioningStatus renders as a failure card with
            // retry. Nothing extra needed here.
          },
          onError: (err: any) => {
            setLaunchError(
              err instanceof Error ? err.message : 'Unknown provisioning stream error',
            );
          },
          ...(typeof watchdogMs === 'number' ? { watchdogMs } : {}),
        });
        streamHandleRef.current = handle;
      } catch (err: any) {
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
    (repoUrl: any) => {
      onProjectCreated?.({ repoUrl, projectId: createdProjectId });
    },
    [onProjectCreated, createdProjectId],
  );

  // Manual escape when the first-build handoff never arrives: land the user
  // on the created project's board (a guaranteed target — the build session
  // shows up there once it starts), or just close if the id is unknown.
  const handleOpenProject = useCallback(() => {
    streamHandleRef.current?.close?.();
    const projectId = createdProjectIdRef.current;
    if (projectId) {
      onProjectCreated?.({ action: 'task', projectId });
    } else {
      onClose?.();
    }
  }, [onProjectCreated, onClose]);

  const terminalDone = useMemo(() => events.find((e: any) => e && e.type === 'done'), [events]);
  const provisioningFailed = terminalDone && terminalDone.error && !terminalDone.partial;

  // Once provisioning reaches a terminal (non-failed) `done`, the flow waits
  // for the `initial_build_started` broadcast to open the first build chat.
  // If that never arrives — first-build creation failed after `done`, the
  // main WebSocket reconnected and dropped the transient event, or it was
  // otherwise missed — reveal a manual escape so the user is never stuck on
  // "Opening the first build session…".
  useEffect(() => {
    if (!terminalDone || provisioningFailed) return;
    if (openedBuildSessionRef.current) return;
    const timer = setTimeout(() => {
      if (!openedBuildSessionRef.current) setBuildHandoffTimedOut(true);
    }, buildHandoffTimeoutMs);
    return () => clearTimeout(timer);
  }, [terminalDone, provisioningFailed, buildHandoffTimeoutMs]);

  const handlePickType = useCallback(
    (type: any) => {
      if (type === 'workflow') {
        setView('workflow-form');
        return;
      }
      if (type === 'import') {
        onProjectCreated?.({ action: 'import' });
        return;
      }
      // Default: new code repo — adaptive questionnaire + provisioning.
      setView('questionnaire');
    },
    [onProjectCreated],
  );

  // Workflow-form submit: POST /api/projects with mode:'workflow' and
  // route the host to the new project's kanban (action:'task' is the
  // existing host signal that transitions to `kanban:<projectId>`).
  const handleWorkflowSubmit = useCallback(
    async ({ name, description, color, visibility }: any) => {
      const project = await createWorkflowProject({ name, description, color, visibility });
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

  return (
    <div className="flex flex-col w-full h-full" data-testid="new-project-adaptive-flow">
      {launchError && !events.some((e: any) => e.type === 'done') && (
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
          withToolchain={withToolchain}
          onRetry={handleRetry}
          onClose={provisioningFailed ? handleClose : undefined}
          onOpenRepo={handleOpenRepo}
          onOpenProject={handleOpenProject}
          buildHandoffTimedOut={buildHandoffTimedOut}
        />
      </div>
    </div>
  );
}

/** Language starters that still run wire-tests / wire-lint. Keep in
 *  sync with `KNOWN_TEMPLATE_IDS` minus `blank` in stack-defaults.ts. */
const LANGUAGE_STARTER_STACKS = new Set([
  'python-fastapi-uv',
  'typescript-node-tsx',
  'go-cobra',
  'rust-axum',
]);

/** True when the payload asked for a concrete language template so the
 *  checklist should show Wire tests / Wire lint. Description-first
 *  (blank / idk) hides them — they were skipped, not run. */
export function inferWithToolchain(payload: any) {
  if (!payload || typeof payload.stack !== 'string') return false;
  return LANGUAGE_STARTER_STACKS.has(payload.stack);
}

/**
 * Determine whether the ProvisioningStatus UI should render the gh-*
 * phases. `idk` means "defer to agent default" — we keep gh enabled so
 * the status row stays visible if the agent chooses to publish.
 */
export function inferWithGithub(payload: any) {
  if (!payload) return true;
  // Mirrors the server's hasGithubIntegration: the hosting answer is the
  // single source of truth — Agent Hub-hosted projects never create a
  // GitHub repo (connect one later in Settings). Only explicit
  // GitHub-only hosting shows/runs the gh-* phases.
  if (payload.hostOnAgentHub !== false) return false;
  const { integrations } = payload;
  if (integrations === 'idk' || integrations == null) return true;
  if (Array.isArray(integrations)) return integrations.includes('github');
  return true;
}

/* -------------------------------------------------------------------------- */
/* Project type picker — Step 0 of the New Project flow.                      */
/* -------------------------------------------------------------------------- */

/**
 * Top-level picker: new code repo (scaffold), import existing repo (host
 * routes to OpenProjectWizard), or workflow / non-code project. Exported
 * for tests.
 */
export function ProjectTypePicker({ onPick, onClose }: any) {
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
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-white">What kind of project?</h2>
            <p className="mt-1 text-sm text-gray-400">
              Create a new code repo from our scaffold, link an existing Git repository, or start a
              workflow-only space (kanban / wiki / agents with no repo).
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                <div className="text-sm font-semibold text-white">Create new code project</div>
                <p className="mt-1 text-xs text-gray-400">
                  Describe the product. The first build session chooses the stack, writes the code,
                  tests, Docker setup, and preview. Optionally host on GitHub.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onPick('import')}
              data-testid="ptp-import"
              className="group flex h-full flex-col items-start gap-3 rounded-xl border border-gray-700 bg-gray-900/60 p-5 text-left transition-colors hover:border-sky-500 hover:bg-sky-500/5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-900/40 text-sky-300 group-hover:bg-sky-500/20">
                <FolderGit2 size={20} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-white">Import existing project</div>
                <p className="mt-1 text-xs text-gray-400">
                  Point at a GitHub repo or local folder you already have. No scaffold wizard —
                  Agents, kanban, and wiki attach to that codebase.
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
export function WorkflowProjectForm({ onSubmit, onBack, onClose }: any) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(WORKFLOW_COLOR_OPTIONS[0].value);
  // Visibility toggle: shared (default — visible to every member of the
  // org) vs. private (visible only to the creator). The latter is also
  // surfaced in Settings → Projects for org Owners as a kill switch.
  const [visibility, setVisibility] = useState('shared');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);

  const trimmed = name.trim();
  const slugPreview = useMemo(() => slugifyProjectId(trimmed), [trimmed]);
  const canSubmit = trimmed.length > 0 && slugPreview.length >= 3 && !submitting;

  const handleSubmit = useCallback(
    async (e: any) => {
      if (e?.preventDefault) e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        await onSubmit?.({
          name: trimmed,
          description: description.trim(),
          color,
          visibility,
        });
        // Don't reset state — onSubmit's host handler unmounts us by
        // routing to the new project's kanban view.
      } catch (err: any) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(false);
      }
    },
    [canSubmit, color, description, onSubmit, trimmed, visibility],
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
            sessions and crons — no repo, no worktrees.
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
              onChange={(e: any) => setName(e.target.value)}
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
              onChange={(e: any) => setDescription(e.target.value)}
              data-testid="wpf-description-input"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-y transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Color</label>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2" data-testid="wpf-color-options">
              {WORKFLOW_COLOR_OPTIONS.map((opt: any) => {
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

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Visibility</label>
            <div
              className="grid grid-cols-2 gap-2"
              data-testid="wpf-visibility-options"
              role="radiogroup"
              aria-label="Project visibility"
            >
              {[
                {
                  value: 'shared',
                  label: 'Shared',
                  hint: 'Visible to every member of your org',
                },
                {
                  value: 'private',
                  label: 'Private',
                  hint: 'Visible only to you',
                },
              ].map((opt: any) => {
                const selected = visibility === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setVisibility(opt.value)}
                    data-testid={`wpf-visibility-${opt.value}`}
                    className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                      selected
                        ? 'border-emerald-500 bg-emerald-900/20'
                        : 'border-gray-700 hover:border-gray-500 bg-gray-950'
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-100">{opt.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.hint}</div>
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
