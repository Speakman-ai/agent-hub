/**
 * Per-recipient broadcast visibility filter.
 *
 * `websocket.ts#broadcast` fans every event to every connected client.
 * Without filtering, a connected user receives notifications for events
 * on private projects they cannot view — e.g. user B's Electron shows a
 * "session complete" banner for a private project owned by user A.
 *
 * The filter consults `resolveProjectIdFromEvent` to find the project
 * the event is about, then `canViewProject` to decide whether each
 * stamped WebSocket recipient should see it.
 *
 * Policy:
 *   - Unresolvable events (no projectId, missing lookups) fan out
 *     globally. We do NOT silently drop unfamiliar events — that would
 *     break new event types added without resolver coverage.
 *   - Unknown project ids (resolved id missing from the in-memory model)
 *     also fan out globally. Best-effort; mirrors the legacy behavior
 *     for events about projects that have since been deleted.
 *   - Clients with no visibility stamp fall back to the legacy
 *     "see everything" behavior to avoid breaking the local-bundled
 *     server, the apiKey break-glass, or test harnesses that connect
 *     without an auth setup.
 *   - localBypass clients always see every event (single-tenant local
 *     mode and the global apiKey path).
 *
 * Pure module: all collaborators are injected so the filter has no
 * direct dependency on the running db / project model.
 */

import { canViewProject, type VisibilityCaller } from './project-visibility.js';
import type { Project } from './types.js';
import type { BroadcastEvent } from './event-project-resolver.js';
import type { WsVisibilityStamp } from './session-ownership.js';

export interface BroadcastFilterDeps {
  /** Resolve a projectId from the broadcast payload; null when unresolvable. */
  resolveProjectId: (data: BroadcastEvent) => string | null;
  /** Look up a project by id; null when unknown. */
  findProject: (projectId: string) => Project | null;
  /**
   * Resolve `sessions.owner_user_id`; null when unowned or unknown.
   *
   * Required, not optional: session-private events now fail closed, so an
   * omitted resolver would silently black-hole them rather than degrade. The
   * type makes every call site hand one over.
   */
  getSessionOwner: (sessionId: string) => string | null;
}

/**
 * Event types whose payload is private to the session owner rather than to
 * everyone who can view the project.
 *
 * Background-shell rows carry the exact command line, cwd, pid, and log path
 * of work an agent parked in someone's session. The REST surface gates all of
 * it on `userOwnsSession`; project visibility alone is weaker than that,
 * because the default project is shared across the org. Fan-out has to match
 * the REST gate or the WebSocket becomes the way around it.
 */
const SESSION_PRIVATE_EVENT_TYPES = new Set([
  'background_shell_update',
  // Session Progress / event timeline can include startup-hook command lines
  // and output tails — same ownership gate as background shells.
  'session-event',
  'session-progress',
]);

/**
 * Owner check for a session-scoped payload. Exported so the WebSocket connect
 * snapshot — which sends rows grouped by session rather than as typed events —
 * applies the identical rule.
 *
 * This is `userOwnsSession` transposed onto the fan-out, deliberately including
 * its strict cases. The push-side `filterTokensForSessionOwner` is more lenient,
 * but a push is a notification the owner opted into; this is the payload itself.
 *
 *   - **No stamp / `localBypass` → deliver.** These are exactly the callers
 *     `userOwnsSession` waves through: no auth configured, the `x-api-key`
 *     break-glass, and bundled-local. `websocket.ts` stamps every accepted
 *     connection and sets `localBypass` whenever there is no `userId`, so a
 *     recipient reaching the checks below always has a real user id to scope
 *     against.
 *   - **Unowned session (`owner === null`) → deny.** Cron / heartbeat /
 *     autonomous spawns whose owner could not be resolved, and pre-migration
 *     rows, belong to nobody. `userOwnsSession` grants NULL-owner rows to no
 *     one, so `GET /api/sessions/:id/background-shells` already 404s for every
 *     human on these; fanning the rows out over the WebSocket would light a
 *     watch-loop pill for a panel that cannot load, and leak the command line,
 *     cwd, pid, and log path to the whole org on the way.
 *   - **Missing session id → deny.** A session-private payload we cannot
 *     attribute is not one we can safely broadcast. The runtime always stamps
 *     `sessionId`, so this is a malformed-event guard.
 *   - **No Owner-role override** — `userOwnsSession` grants none either.
 */
export function shouldDeliverSessionScopedBroadcast(
  sessionId: string | null,
  stamp: WsVisibilityStamp | undefined,
  deps: Pick<BroadcastFilterDeps, 'getSessionOwner'>,
): boolean {
  if (!stamp) return true;
  if (stamp.localBypass) return true;
  if (!sessionId) return false;
  const owner = deps.getSessionOwner(sessionId);
  if (!owner) return false;
  return stamp.userId === owner;
}

/**
 * Decide whether a stamped recipient should receive the given broadcast.
 * Exported for tests and reusable by the mobile-push filter (Phase 2 of
 * the same card).
 */
export function shouldDeliverBroadcast(
  data: BroadcastEvent,
  stamp: WsVisibilityStamp | undefined,
  deps: BroadcastFilterDeps,
): boolean {
  // 1. Recipients with no stamp keep legacy behavior. Test harnesses,
  //    local-bundled callers that didn't get a stamp, and any pre-
  //    visibility connection fall here.
  if (!stamp) return true;

  // 2. localBypass collapses every event to "deliver" — single-tenant
  //    local mode, global apiKey break-glass, or no-auth-configured.
  if (stamp.localBypass) return true;

  // 3. Private cron thread entries are scoped to the cron owner plus org
  //    Owners, even when the backing project is shared. Shared crons carry the
  //    same ownerUserId for credential attribution, but cronShared=true means
  //    they should continue through normal project visibility below.
  if (data.type === 'thread_entry_created' && data.cronShared === false) {
    const owner =
      typeof data.ownerUserId === 'string' && data.ownerUserId ? data.ownerUserId : null;
    if (!owner) return true;
    return stamp.role === 'Owner' || stamp.userId === owner;
  }

  // 3b. Personal user-scoped events go only to their owner — NO admin
  //    override. Todos are a private capture primitive (spec TODO-MODEL),
  //    so even an org Owner must not receive another user's todo updates.
  //    A missing ownerUserId falls back to legacy fan-out rather than
  //    silently dropping the event.
  if (data.type === 'user_todo_update') {
    const owner =
      typeof data.ownerUserId === 'string' && data.ownerUserId ? data.ownerUserId : null;
    if (!owner) return true;
    return stamp.userId === owner;
  }

  // 3c. Session-private events are gated on session ownership *in addition
  //    to* project visibility — the project check below still runs, so a
  //    recipient needs both.
  if (typeof data.type === 'string' && SESSION_PRIVATE_EVENT_TYPES.has(data.type)) {
    const sid = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
    if (!shouldDeliverSessionScopedBroadcast(sid, stamp, deps)) return false;
  }

  // 4. Try to resolve the event to a project. Unresolvable events keep
  //    the legacy fan-out semantics; deny-on-unresolved would silently
  //    break new event types and any payload whose project model isn't
  //    encoded in the resolver yet.
  const projectId = deps.resolveProjectId(data);
  if (!projectId) return true;

  const project = deps.findProject(projectId);
  if (!project) {
    // Project was deleted between event emission and dispatch (or the
    // resolver was wrong). Default to deliver — the recipient will
    // either see a noop UI update or a notification for a project that
    // is genuinely gone, both of which are strictly less bad than
    // dropping events about real projects.
    return true;
  }

  const caller: VisibilityCaller = {
    userId: stamp.userId,
    role: stamp.role,
    localBypass: false,
  };
  return canViewProject(project, caller);
}
