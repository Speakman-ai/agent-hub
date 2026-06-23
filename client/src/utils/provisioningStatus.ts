/**
 * Provisioning status — pure state model + helpers.
 *
 * Drives the "New Project → Provisioning" UI after the Adaptive Questionnaire
 * is submitted. The backend scaffold-builder runs a
 * short-lived scaffold container that creates/pushes the GitHub repo and
 * lands the starter tree. While it runs, the server streams phase events
 * and raw log lines over an event channel (SSE or WS). This module is the
 * pure reducer over those events — deliberately decoupled from transport
 * so it can be unit-tested without spinning up a server.
 *
 * Event shape (server → client):
 *   {type:'phase', phase:'validate'|'mint-token'|'copy-template'|'rewrite-pkg'|'wire-tests'|'wire-lint'|'git-init'|'gh-create'|'gh-push', status:'started'|'ok'|'failed'|'skipped', message?, at:<ISO>}
 *   {type:'log',   line:'...', at:<ISO>}
 *   {type:'done',  repoUrl?:string, partial?:boolean, error?:{code:number,message:string,hint?:string}}
 *
 * Partial success contract:
 *   If gh-create or gh-push fails but local scaffold completed, the server
 *   emits {type:'done', partial:true, error:{...}}. The UI surfaces the
 *   local scaffold as usable while the remote push is missing — matching
 *   the storyboard's "Act III" amber state.
 */

/** Ordered phases used by the checklist. A phase absent from the stream is
 *  rendered as 'pending' until a `{type:'phase', status:'started'}` lands. */
export const PROVISIONING_PHASES = [
  { id: 'validate', label: 'Validate request' },
  { id: 'mint-token', label: 'Authorize GitHub', gh: true },
  { id: 'copy-template', label: 'Copy starter template' },
  { id: 'rewrite-pkg', label: 'Configure package metadata' },
  { id: 'wire-tests', label: 'Wire tests' },
  { id: 'wire-lint', label: 'Wire lint' },
  { id: 'git-init', label: 'Initialize git repo' },
  { id: 'gh-create', label: 'Create GitHub repo', gh: true },
  { id: 'gh-push', label: 'Push initial commit', gh: true },
];

/** Phases we skip entirely when the user opted out of GitHub integration. */
export function phasesForRequest({ withGithub }: any = { withGithub: true }) {
  if (withGithub) return PROVISIONING_PHASES;
  return PROVISIONING_PHASES.filter((p: any) => !p.gh);
}

/** Fresh state — used on mount and on Retry. */
export function initialState({ withGithub }: any = { withGithub: true }) {
  const phases = phasesForRequest({ withGithub });
  return {
    phases: phases.map((p: any) => ({
      ...p,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    })),
    logs: [] as any[], // {line, at}
    overall: 'idle', // idle | running | success | partial | failed
    repoUrl: null,
    error: null, // {code, message, hint?}
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Pure reducer: apply one server event to the previous state. Unknown
 * event types are no-ops (forward-compat with future phases).
 *
 * We cap the log buffer at LOG_BUFFER_MAX to keep long-running tails from
 * ballooning memory. The UI can show "…truncated" when state.logs.length
 * equals the cap.
 */
export const LOG_BUFFER_MAX = 2000;

export function reduceEvent(state: any, event: any) {
  if (!event || typeof event !== 'object') return state;
  const ts = event.at || new Date().toISOString();
  switch (event.type) {
    case 'phase':
      return applyPhase(state, event, ts);
    case 'log':
      return applyLog(state, event, ts);
    case 'done':
      return applyDone(state, event, ts);
    default:
      return state;
  }
}

function applyPhase(state: any, event: any, ts: any) {
  const { phase, status, message } = event;
  const idx = state.phases.findIndex((p: any) => p.id === phase);
  if (idx === -1) return state;
  const prev = state.phases[idx];
  const next: Record<string, any> = {
    ...prev,
    status: status || prev.status,
    message: message ?? prev.message,
  };
  if (status === 'started' && !prev.startedAt) next.startedAt = ts;
  if (status === 'ok' || status === 'failed' || status === 'skipped') {
    if (!next.startedAt) next.startedAt = ts;
    next.finishedAt = ts;
  }
  const phases = [...state.phases];
  phases[idx] = next;
  const overall =
    state.overall === 'idle'
      ? 'running'
      : status === 'failed'
        ? state.overall // 'done' event finalizes; phase failure alone leaves us running until done lands
        : state.overall;
  const startedAt = state.startedAt || ts;
  return { ...state, phases, overall, startedAt };
}

function applyLog(state: any, event: any, ts: any) {
  const line = typeof event.line === 'string' ? event.line : '';
  if (!line) return state;
  const entry = { line, at: ts };
  const logs =
    state.logs.length >= LOG_BUFFER_MAX
      ? [...state.logs.slice(state.logs.length - LOG_BUFFER_MAX + 1), entry]
      : [...state.logs, entry];
  return { ...state, logs };
}

function applyDone(state: any, event: any, ts: any) {
  const repoUrl = event.repoUrl ?? state.repoUrl;
  const error = event.error ?? null;
  let overall: any;
  if (error && event.partial) overall = 'partial';
  else if (error) overall = 'failed';
  else overall = 'success';
  return {
    ...state,
    overall,
    repoUrl,
    error,
    finishedAt: ts,
  };
}

/**
 * Classify a scaffold exit code into an actionable error hint. Exit codes
 * map to scaffold.sh and scaffold-builder.ts conventions:
 *   -2  pre-flight (validation, mint-token)
 *   -1  container timeout
 *    2  bad spec
 *    3  template copy failed
 *    4  git init/commit failed
 *    5  gh auth / repo create / push failed
 */
export function classifyError(error: any) {
  if (!error) return null;
  const { code, message } = error;
  const hint = hintForCode(code);
  return { code, message, hint: error.hint || hint };
}

function hintForCode(code: any) {
  switch (code) {
    case -2:
      return 'Pre-flight failed — check the GitHub token and the request payload.';
    case -1:
      return 'Scaffold timed out. Try again; if it persists, the container host may be overloaded.';
    case 2:
      return 'Bad scaffold spec. Verify the stack + project name passed validation.';
    case 3:
      return 'Template copy failed inside the container. The base image may be stale — rebuild scaffold-base.';
    case 4:
      return 'Git init/commit failed. Check that the container has a writable /work mount.';
    case 5:
      return 'GitHub operation failed. Verify the token has repo access and the owner is correct.';
    default:
      return 'Unknown failure. See the log tail above for details.';
  }
}

/** Tiny helper for the phase icon decision — keeps component lean. */
export function phaseTone(status: any) {
  switch (status) {
    case 'ok':
      return 'green';
    case 'started':
      return 'amber'; // storyboard: in-flight = amber
    case 'failed':
      return 'red';
    case 'skipped':
      return 'grey';
    case 'pending':
    default:
      return 'grey';
  }
}

/** True if any gh-* phase has status in the given set — used to decide
 *  whether a local-only scaffold partial-success card should appear. */
export function hasGithubFailure(state: any) {
  return state.phases.some((p: any) => p.gh && p.status === 'failed');
}
