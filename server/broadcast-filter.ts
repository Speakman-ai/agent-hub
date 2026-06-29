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
