/**
 * PR environment lifecycle state machine (pure).
 *
 * One `pr_environments` row exists per (project, source, PR number). The row is
 * keyed by the PR, never by a chat session: a PR on any head branch gets an
 * environment as long as its project declares a `preview:` block in
 * `.agent-hub/deploy.yaml`.
 *
 * Every (re)build bumps `generation`. Runtime callbacks carry the generation
 * they were started for, so a `ready` from a superseded build (an older head
 * sha, or a build that was stopped mid-flight) can never flip the row.
 *
 * `cleanupPending` is set whenever a teardown is requested and cleared only
 * when the runtime confirms it. While it is set, a repeated stop retries the
 * teardown and a replacement build is not started.
 */

/** Where the PR lives: the Hub's own forge, or GitHub for GitHub-hosted projects. */
export type PrEnvironmentSource = 'native' | 'github';
export type PrEnvironmentStatus = 'queued' | 'building' | 'ready' | 'failed' | 'stopped';
export type PrEnvironmentStopReason =
  | 'merged'
  | 'closed'
  | 'manual'
  | 'no_preview_config'
  /** Asleep: no requests within the idle TTL, or evicted by the project cap. A request wakes it. */
  | 'idle'
  /** The PR head went unchanged past the max lifetime. A push or manual start revives it. */
  | 'expired';

/** Stopped by a cost control rather than by anyone's decision about the PR. */
export function isCostStopReason(reason: PrEnvironmentStopReason | null): boolean {
  return reason === 'idle' || reason === 'expired';
}

export const PR_ENVIRONMENT_ACTIVE_STATUSES: readonly PrEnvironmentStatus[] = [
  'queued',
  'building',
  'ready',
];

export interface PrEnvironmentState {
  status: PrEnvironmentStatus;
  headSha: string;
  headBranch: string | null;
  generation: number;
  url: string | null;
  runnerRef: string | null;
  error: string | null;
  stopReason: PrEnvironmentStopReason | null;
  /** A teardown was requested and has not been confirmed yet. */
  cleanupPending: boolean;
  /**
   * What the pending teardown must remove: the runner identity of the build
   * that was live when the teardown was requested. Kept until the runtime
   * confirms, so retries (and recovery after the runtime was absent) still
   * know the old runner after a replacement row has cleared `runnerRef`.
   */
  cleanupTarget: PrEnvironmentCleanupTarget | null;
}

export interface PrEnvironmentCleanupTarget {
  generation: number;
  headSha: string;
  headBranch: string | null;
  runnerRef: string | null;
  url: string | null;
}

export type PrEnvironmentEvent =
  /** PR opened, reopened, or its head moved (push / synchronize). */
  | { type: 'pr_open'; headSha: string; headBranch: string | null }
  /** Operator asked for an environment. Rebuilds a failed/stopped one at the same sha. */
  | { type: 'manual_start'; headSha: string; headBranch: string | null }
  /** PR merged or closed. */
  | { type: 'pr_closed'; merged: boolean }
  | { type: 'manual_stop' }
  /** Cost control: idle past the TTL, or evicted to make room under the project cap. */
  | { type: 'idle_stop' }
  /** Cost control: the PR head went unchanged past the max lifetime. */
  | { type: 'expire' }
  /** A request reached a sleeping (`idle`) environment; rebuild it at the PR's current head. */
  | { type: 'wake'; headSha: string; headBranch: string | null }
  /** The head moved to a commit whose deploy.yaml has no `preview:` block. */
  | { type: 'config_removed'; headSha: string; headBranch: string | null }
  /**
   * The head commit could not be read, so whether it declares `preview:` is
   * unknown. Recorded as `failed` at that head so nothing runs a stale commit;
   * a manual start re-probes.
   */
  | { type: 'config_unresolved'; headSha: string; headBranch: string | null; error: string }
  /**
   * A build in flight when the Hub stopped has no live reporter and the
   * runtime could not adopt it: fail it (Retry rebuilds) and tear down
   * whatever it left behind.
   */
  | { type: 'build_interrupted'; generation: number; error: string }
  /** The runtime could not tear the environment down. */
  | { type: 'teardown_failed'; error: string }
  /** The runtime confirmed the teardown. */
  | { type: 'teardown_done' }
  | { type: 'runtime_building'; generation: number; runnerRef: string | null }
  | { type: 'runtime_ready'; generation: number; url: string }
  | { type: 'runtime_failed'; generation: number; error: string }
  /**
   * The runner hosting this generation died (instance reclaimed, agent
   * crashed, container gone). The stack is down; tear down what may be left
   * and, when `requeue`, build again at the same head.
   */
  | { type: 'runtime_lost'; generation: number; error: string; requeue: boolean };

export interface PrEnvironmentEffects {
  /** Tear down whatever is running (or may still be running). */
  teardown: boolean;
  /** Start a build for the new generation (only after a successful teardown). */
  build: boolean;
}

export interface PrEnvironmentTransition {
  /** Next state, or `null` when the event leaves no row (nothing to track). */
  next: PrEnvironmentState | null;
  /** True when `next` differs from the input and must be persisted. */
  changed: boolean;
  /** Effects may be requested without a state change (retrying a teardown). */
  effects: PrEnvironmentEffects;
}

const NO_EFFECTS: PrEnvironmentEffects = { teardown: false, build: false };

/**
 * Prefix of the error recorded when the head commit could not be read. Such a
 * row did not fail to build; it never knew whether to build. A later open at
 * the same head (the stored delivery's retry) is allowed to rebuild it.
 */
export const UNRESOLVED_HEAD_ERROR_PREFIX = 'Could not read head commit';

export function isUnresolvedHeadError(error: string | null): boolean {
  return error?.startsWith(UNRESOLVED_HEAD_ERROR_PREFIX) ?? false;
}

export function isActivePrEnvironmentStatus(status: PrEnvironmentStatus): boolean {
  return PR_ENVIRONMENT_ACTIVE_STATUSES.includes(status);
}

function unchanged(current: PrEnvironmentState | null): PrEnvironmentTransition {
  return { next: current, changed: false, effects: NO_EFFECTS };
}

/**
 * The resources a teardown requested now must remove. An unconfirmed earlier
 * target wins: it names the oldest runner still possibly alive.
 */
function cleanupTargetFor(current: PrEnvironmentState): PrEnvironmentCleanupTarget {
  return (
    current.cleanupTarget ?? {
      generation: current.generation,
      headSha: current.headSha,
      headBranch: current.headBranch,
      runnerRef: current.runnerRef,
      url: current.url,
    }
  );
}

/** Something may still be running for this row and needs a teardown. */
function needsTeardown(current: PrEnvironmentState | null): boolean {
  return current !== null && (current.status !== 'stopped' || current.cleanupPending);
}

function queue(
  current: PrEnvironmentState | null,
  headSha: string,
  headBranch: string | null,
): PrEnvironmentTransition {
  const teardown = needsTeardown(current);
  return {
    next: {
      status: 'queued',
      headSha,
      headBranch: headBranch ?? current?.headBranch ?? null,
      generation: (current?.generation ?? 0) + 1,
      url: null,
      runnerRef: null,
      error: null,
      stopReason: null,
      cleanupPending: teardown,
      cleanupTarget: teardown && current ? cleanupTargetFor(current) : null,
    },
    changed: true,
    // A failed build may have left a half-up stack behind, so tear down
    // anything not confirmed down before building again.
    effects: { teardown, build: true },
  };
}

function stop(
  current: PrEnvironmentState | null,
  reason: PrEnvironmentStopReason,
): PrEnvironmentTransition {
  if (!current) return unchanged(null);
  if (current.status === 'stopped') {
    // Already down. A terminal PR reason (merged/closed) always wins, so a
    // later manual start on a GitHub PR knows the PR is gone. A manual stop
    // replaces a nonterminal reason (no_preview_config), so restoring the
    // preview block later does not override the operator's stop.
    // Cost-control reasons are the weakest: any decision about the PR or its
    // config replaces them, and they never replace one. `expired` may replace
    // `idle` (a sleeping env whose PR went stale must stop answering wakes).
    const terminal = reason === 'merged' || reason === 'closed';
    const currentTerminal = current.stopReason === 'merged' || current.stopReason === 'closed';
    const replace =
      current.stopReason !== reason &&
      (terminal ||
        (reason === 'manual' && !currentTerminal) ||
        (reason === 'no_preview_config' && isCostStopReason(current.stopReason)) ||
        (reason === 'expired' && current.stopReason === 'idle'));
    const next = replace ? { ...current, stopReason: reason } : current;
    return {
      next,
      changed: next !== current,
      // A teardown that failed earlier is retried on every stop/close.
      effects: { teardown: current.cleanupPending, build: false },
    };
  }
  return {
    next: {
      ...current,
      status: 'stopped',
      url: null,
      stopReason: reason,
      cleanupPending: true,
      cleanupTarget: cleanupTargetFor(current),
    },
    changed: true,
    effects: { teardown: true, build: false },
  };
}

export function transitionPrEnvironment(
  current: PrEnvironmentState | null,
  event: PrEnvironmentEvent,
): PrEnvironmentTransition {
  switch (event.type) {
    case 'pr_open': {
      if (
        current &&
        current.headSha === event.headSha &&
        (isActivePrEnvironmentStatus(current.status) ||
          (current.status === 'failed' && !isUnresolvedHeadError(current.error)))
      ) {
        // Same commit already queued/building/ready, or it failed at this sha:
        // a replayed webhook must not loop a broken build. Manual start retries.
        return unchanged(current);
      }
      if (current && current.status === 'stopped' && current.stopReason === 'manual') {
        // The operator turned it off. A new commit does not override that
        // until they start it again; keep the sha current for that start.
        if (current.headSha === event.headSha) return unchanged(current);
        return {
          next: { ...current, headSha: event.headSha, headBranch: event.headBranch },
          changed: true,
          effects: NO_EFFECTS,
        };
      }
      if (current && current.status === 'stopped' && isCostStopReason(current.stopReason)) {
        // Asleep: a replayed open must not rebuild it, only a request does.
        // A push moves the head and revives an expired env as sleeping, so the
        // next request wakes it at the new commit.
        if (current.headSha === event.headSha) return unchanged(current);
        return {
          next: {
            ...current,
            headSha: event.headSha,
            headBranch: event.headBranch ?? current.headBranch,
            stopReason: 'idle',
          },
          changed: true,
          effects: NO_EFFECTS,
        };
      }
      return queue(current, event.headSha, event.headBranch);
    }
    case 'manual_start': {
      if (
        current &&
        current.headSha === event.headSha &&
        isActivePrEnvironmentStatus(current.status) &&
        !current.cleanupPending
      ) {
        return unchanged(current);
      }
      return queue(current, event.headSha, event.headBranch);
    }
    case 'pr_closed':
      return stop(current, event.merged ? 'merged' : 'closed');
    case 'manual_stop':
      return stop(current, 'manual');
    case 'idle_stop':
    case 'expire': {
      // Only a live environment is put to sleep; a failed one has nothing
      // running worth paying for and keeps its error visible. `expire` also
      // marks a sleeping one so requests stop waking it.
      if (!current) return unchanged(null);
      const reason = event.type === 'expire' ? 'expired' : 'idle';
      if (current.status === 'stopped') {
        if (reason === 'expired' && current.stopReason === 'idle') return stop(current, reason);
        return unchanged(current);
      }
      if (!isActivePrEnvironmentStatus(current.status)) return unchanged(current);
      return stop(current, reason);
    }
    case 'wake': {
      if (!current || current.status !== 'stopped' || current.stopReason !== 'idle') {
        return unchanged(current);
      }
      return queue(current, event.headSha, event.headBranch);
    }
    case 'config_removed': {
      if (!current) return unchanged(null);
      const t = stop(current, 'no_preview_config');
      const base = t.next ?? current;
      if (
        base.headSha === event.headSha &&
        base.headBranch === (event.headBranch ?? base.headBranch)
      ) {
        return t;
      }
      // Track the new head even when already stopped, so a later start probes
      // the current commit instead of rebuilding the obsolete one.
      return {
        next: { ...base, headSha: event.headSha, headBranch: event.headBranch ?? base.headBranch },
        changed: true,
        effects: t.effects,
      };
    }
    case 'config_unresolved': {
      const headBranch = event.headBranch ?? current?.headBranch ?? null;
      if (
        current &&
        current.status === 'stopped' &&
        (current.stopReason === 'manual' || isCostStopReason(current.stopReason))
      ) {
        // Nothing is running, and nothing should start until a start or a
        // wake, both of which re-read the head.
        if (current.headSha === event.headSha) return unchanged(current);
        const stopReason = current.stopReason === 'manual' ? 'manual' : 'idle';
        return {
          next: { ...current, headSha: event.headSha, headBranch, stopReason },
          changed: true,
          effects: NO_EFFECTS,
        };
      }
      if (
        current &&
        current.status === 'failed' &&
        current.headSha === event.headSha &&
        current.error === event.error
      ) {
        return unchanged(current);
      }
      const teardown = needsTeardown(current);
      return {
        next: {
          status: 'failed',
          headSha: event.headSha,
          headBranch,
          // New generation so callbacks from the build of the old head die.
          generation: (current?.generation ?? 0) + 1,
          url: null,
          runnerRef: null,
          error: event.error,
          stopReason: null,
          cleanupPending: teardown,
          cleanupTarget: teardown && current ? cleanupTargetFor(current) : null,
        },
        changed: true,
        effects: { teardown, build: false },
      };
    }
    case 'build_interrupted': {
      if (!current || current.generation !== event.generation) return unchanged(current);
      if (current.status !== 'queued' && current.status !== 'building') return unchanged(current);
      return {
        next: {
          ...current,
          status: 'failed',
          url: null,
          error: event.error,
          cleanupPending: true,
          cleanupTarget: cleanupTargetFor(current),
        },
        changed: true,
        effects: { teardown: true, build: false },
      };
    }
    case 'teardown_failed': {
      if (!current) return unchanged(null);
      const error = `Teardown failed: ${event.error}`;
      // A replacement build waiting on this teardown must not start over a
      // stack that may still be running: surface it as failed (Retry tears
      // down again first).
      const status = current.status === 'queued' ? 'failed' : current.status;
      return {
        next: {
          ...current,
          status,
          url: null,
          cleanupPending: true,
          cleanupTarget: cleanupTargetFor(current),
          error,
        },
        changed: true,
        effects: NO_EFFECTS,
      };
    }
    case 'teardown_done': {
      if (!current || !current.cleanupPending) return unchanged(current);
      const clearError = current.error?.startsWith('Teardown failed:') ?? false;
      return {
        next: {
          ...current,
          cleanupPending: false,
          cleanupTarget: null,
          error: clearError ? null : current.error,
        },
        changed: true,
        effects: NO_EFFECTS,
      };
    }
    case 'runtime_building': {
      if (!current || current.generation !== event.generation) return unchanged(current);
      if (current.status !== 'queued') return unchanged(current);
      return {
        next: { ...current, status: 'building', runnerRef: event.runnerRef ?? current.runnerRef },
        changed: true,
        effects: NO_EFFECTS,
      };
    }
    case 'runtime_ready': {
      if (!current || current.generation !== event.generation) return unchanged(current);
      if (current.status !== 'queued' && current.status !== 'building') return unchanged(current);
      return {
        next: { ...current, status: 'ready', url: event.url, error: null },
        changed: true,
        effects: NO_EFFECTS,
      };
    }
    case 'runtime_lost': {
      if (!current || current.generation !== event.generation) return unchanged(current);
      if (!isActivePrEnvironmentStatus(current.status)) return unchanged(current);
      if (event.requeue) {
        const t = queue(current, current.headSha, current.headBranch);
        // Keep the reason visible while the replacement builds; a ready
        // report clears it.
        return { ...t, next: { ...t.next!, error: event.error } };
      }
      return {
        next: {
          ...current,
          status: 'failed',
          url: null,
          error: event.error,
          cleanupPending: true,
          cleanupTarget: cleanupTargetFor(current),
        },
        changed: true,
        effects: { teardown: true, build: false },
      };
    }
    case 'runtime_failed': {
      if (!current || current.generation !== event.generation) return unchanged(current);
      if (!isActivePrEnvironmentStatus(current.status)) return unchanged(current);
      return {
        next: { ...current, status: 'failed', url: null, error: event.error },
        changed: true,
        effects: NO_EFFECTS,
      };
    }
    default:
      return unchanged(current);
  }
}
