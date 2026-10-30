/**
 * A session's "Run QA Tests" on the wire, and the action-bar state the web
 * and mobile clients render from it.
 *
 * Before the session merges the control is a checkbox ("run QA once this
 * merges"); after it merges it is a button. Once a plan exists the control
 * also links to it.
 */

export type QaSessionRequestStatus =
  | 'armed'
  | 'authoring'
  | 'waiting'
  | 'launching'
  | 'started'
  | 'failed';

export interface QaSessionRequestWire {
  sessionId: string;
  projectId: string;
  status: QaSessionRequestStatus;
  planId: string | null;
  planTitle: string | null;
  runId: string | null;
  dueAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QaSessionStateWire {
  request: QaSessionRequestWire | null;
  merged: boolean;
  defaultEnvironment: { id: string; name: string; baseUrl: string } | null;
  delayMinutes: number;
  hasQaAgent: boolean;
}

export interface QaSessionControl {
  kind: 'checkbox' | 'button';
  checked: boolean;
  /** True while a request is drafting or waiting, so the button cannot double-fire. */
  busy: boolean;
  /** Why the control cannot start QA (no QA agent, no default env), else null. */
  blocked: string | null;
  /**
   * Whether the control can be used right now. A missing prerequisite only
   * blocks starting QA: an already ticked checkbox stays untickable so the
   * pending request can always be cancelled.
   */
  enabled: boolean;
  /** Plan to link to once one was created. */
  planId: string | null;
  /** One short line on where the request stands, or null. */
  status: string | null;
  /** Tooltip for the control. */
  title: string;
}

function formatTime(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  return minutes === 1 ? 'in 1 min' : `in ${minutes} min`;
}

export function qaSessionControl(state: QaSessionStateWire, now = Date.now()): QaSessionControl {
  const { request, merged, defaultEnvironment, delayMinutes } = state;
  const blocked = !state.hasQaAgent
    ? 'This project has no QA agent.'
    : !defaultEnvironment
      ? 'Mark a QA environment as Default in QA settings first.'
      : !defaultEnvironment.baseUrl
        ? `The default QA environment "${defaultEnvironment.name}" has no base URL.`
        : null;
  const delay = delayMinutes > 0 ? `${delayMinutes} min after merge` : 'right after merge';
  const where = defaultEnvironment ? ` on ${defaultEnvironment.name}` : '';
  const busy =
    request?.status === 'authoring' ||
    request?.status === 'waiting' ||
    request?.status === 'launching';
  let status: string | null = null;
  switch (request?.status) {
    case 'armed':
      status = merged ? 'Starting QA…' : null;
      break;
    case 'authoring':
      status = 'QA agent is drafting test cases';
      break;
    case 'waiting':
      status = request.dueAt ? `QA run starts ${formatTime(request.dueAt, now)}` : 'QA run queued';
      break;
    case 'launching':
      status = 'QA run starting';
      break;
    case 'started':
      status = 'QA run started';
      break;
    case 'failed':
      status = request.error ? `QA failed: ${request.error}` : 'QA failed';
      break;
  }
  if (!merged) {
    const checked = !!request && request.status !== 'failed';
    return {
      kind: 'checkbox',
      checked,
      busy,
      blocked,
      enabled: !busy && (checked || !blocked),
      planId: request?.planId ?? null,
      status,
      title: blocked
        ? checked
          ? `${blocked} Untick to cancel.`
          : blocked
        : `Draft and run a QA plan from this session${where}, ${delay}`,
    };
  }
  return {
    kind: 'button',
    checked: false,
    busy,
    blocked,
    enabled: !busy && !blocked,
    planId: request?.planId ?? null,
    status,
    title:
      blocked ??
      `Draft a QA plan from this session and run it${where}${delayMinutes > 0 ? ` (waits ${delay})` : ''}`,
  };
}
