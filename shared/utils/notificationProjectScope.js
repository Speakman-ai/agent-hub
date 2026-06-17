/**
 * Project-scoped notification delivery.
 *
 * Push + foreground banners should only fire for projects the recipient
 * owns (`project.ownerUserId`). Shared/private visibility still governs
 * what you can *see* in the app; notifications are stricter.
 *
 * Delivery rule (strict — an owned project goes to its owner only):
 *   1. `localBypass` → deliver. Callers set this when there is NO per-user
 *      boundary to enforce (local/bundled single-user server, apiKey
 *      break-glass, or an unattributed connection). It is the explicit
 *      "no boundary" signal — the function never infers it from a missing
 *      `currentUserId`.
 *   2. Ownerless (legacy) project → deliver, so pre-migration installs do
 *      not go silent.
 *   3. Otherwise deliver only when `currentUserId === projectOwnerUserId`.
 *      A missing/unknown `currentUserId` does NOT match an owner, so an
 *      unattributed device on a multi-user server is correctly excluded
 *      from owner-only / private-project notifications.
 */

/**
 * @param {string | null | undefined} projectOwnerUserId
 * @param {string | null | undefined} currentUserId
 * @param {{ localBypass?: boolean }=} opts
 */
export function shouldNotifyUserForProject(projectOwnerUserId, currentUserId, opts = {}) {
  if (opts.localBypass) return true;
  const owner =
    typeof projectOwnerUserId === 'string' && projectOwnerUserId ? projectOwnerUserId : null;
  if (!owner) return true;
  const me = typeof currentUserId === 'string' && currentUserId ? currentUserId : null;
  // Owner present: deliver only to that owner. A null/unknown `me` falls
  // through to `false` — without an explicit `localBypass`, an unattributed
  // recipient must not receive an owned project's notifications.
  return owner === me;
}

/**
 * Resolve a project id from a broadcast/push payload just enough for
 * client-side notification scoping (explicit id, then agent hop).
 *
 * @param {object | null | undefined} data
 * @param {Array<{ id: string, projectId?: string }>=} agents
 */
export function resolveNotificationProjectId(data, agents = []) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.projectId === 'string' && data.projectId) return data.projectId;
  if (typeof data.agentId === 'string' && data.agentId) {
    const agent = agents.find((a) => a.id === data.agentId);
    return typeof agent?.projectId === 'string' && agent.projectId ? agent.projectId : null;
  }
  return null;
}

/**
 * @param {object | null | undefined} data
 * @param {string | null | undefined} currentUserId
 * @param {Array<{ id: string, ownerUserId?: string | null }>=} projects
 * @param {Array<{ id: string, projectId?: string }>=} agents
 * @param {{ localBypass?: boolean }=} opts
 */
export function shouldDeliverProjectNotification(
  data,
  currentUserId,
  projects = [],
  agents = [],
  opts = {},
) {
  const projectId = resolveNotificationProjectId(data, agents);
  if (!projectId) return true;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return true;
  return shouldNotifyUserForProject(project.ownerUserId, currentUserId, opts);
}
