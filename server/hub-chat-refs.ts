/**
 * Mentions and entity references in Agent Hub chat.
 *
 * A message body carries refs as canonical tokens, `@[label](kind:id)`, with
 * kinds user, agent, session, card, ticket and pr. A PR id is
 * `<projectId>#<number>`; every other id is the row id.
 *
 * On post and edit the server re-resolves every token as the author. A token
 * the author cannot see (another org's user, a project they cannot view, a
 * session they cannot read) or that names nothing is flattened to its plain
 * label, so the body keeps reading naturally but carries no ref. The tokens
 * that survive are written to `hub_chat_refs`, which drives mention counts,
 * mention pushes and backlinks.
 *
 * Viewers resolve refs again when rendering (`resolveRefsForViewer`), so a
 * chip shows live status to someone who can open it and only its label to
 * someone who cannot.
 */

import { getDb } from './db.js';
import { formatCardShortId } from './kanban-short-id.js';
import { getMembershipRole, listMembersForOrg } from './memberships-store.js';
import { canViewProject, type VisibilityCaller } from './project-visibility.js';
import { assignedProjectIdsForUser, restrictedProjectIds } from './project-members-store.js';
import { userCanReadSession, type OwnerResolvable } from './session-ownership.js';
import { getUserById } from './users-store.js';
import type { Agent, HubChatRefInput, HubChatRefKind, Project } from './types.js';
import {
  escapeMarkdownText,
  hubChatRefDisplay,
  isAtLineStart,
  parseHubChatRefTokens,
  sanitizeHubChatRefLabel,
} from '../shared/utils/hubChatRefTokens.js';
import { locateChatMarkdownCode } from './hub-chat-markdown.js';

// The token grammar (limits, characters, formatting) is shared with every
// client so a token one side writes is one the other side parses.
export {
  HUB_CHAT_REF_KINDS,
  formatHubChatRefToken as formatRefToken,
  parseHubChatRefTokens as parseRefTokens,
} from '../shared/utils/hubChatRefTokens.js';

/** Splits a PR target id (`<projectId>#<number>`). */
export function parsePrTarget(targetId: string): { projectId: string; number: number } | null {
  const hash = targetId.lastIndexOf('#');
  if (hash <= 0) return null;
  const n = Number.parseInt(targetId.slice(hash + 1), 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== targetId.slice(hash + 1)) return null;
  return { projectId: targetId.slice(0, hash), number: n };
}

/**
 * Who is looking. Refs are checked as the Hub user, not as the transport: an
 * agent posting with the global key as its session owner sees only what that
 * owner sees.
 */
export interface RefViewer {
  userId: string;
  orgId: string;
  visibility: VisibilityCaller;
  owner: OwnerResolvable;
}

export interface RefLookups {
  findProject: (projectId: string) => Project | null;
  getProjects: () => Project[];
}

/**
 * Builds the user-scoped viewer. Only the single-tenant local server skips
 * the project ACLs, since it has one user.
 */
export function buildRefViewer(userId: string, orgId: string, localBypass: boolean): RefViewer {
  if (localBypass) {
    return {
      userId,
      orgId,
      visibility: { userId, role: 'Owner', localBypass: true },
      owner: { authUserId: userId, authLocalOrgBypass: true, authRole: 'Owner' },
    };
  }
  const role = getMembershipRole(userId, orgId) ?? undefined;
  let assigned: ReadonlySet<string> = new Set();
  let restricted: ReadonlySet<string> = new Set();
  let unavailable = false;
  try {
    assigned = assignedProjectIdsForUser(userId);
    restricted = restrictedProjectIds();
  } catch {
    unavailable = true;
  }
  return {
    userId,
    orgId,
    visibility: {
      userId,
      role,
      assignedProjectIds: assigned,
      restrictedProjectIds: restricted,
      assignmentAclUnavailable: unavailable,
    },
    owner: { authUserId: userId, authRole: role },
  };
}

function isSystemProject(project: Project): boolean {
  return project.kind === 'system' || project.id === '__hub__';
}

function visibleProject(
  lookups: RefLookups,
  viewer: RefViewer,
  projectId: string | null | undefined,
): Project | null {
  if (!projectId) return null;
  const project = lookups.findProject(projectId);
  if (!project || isSystemProject(project)) return null;
  return canViewProject(project, viewer.visibility) ? project : null;
}

function findAgentInProjects(
  lookups: RefLookups,
  agentId: string,
): { agent: Agent; project: Project } | null {
  for (const project of lookups.getProjects()) {
    const agent = project.agents?.find((a) => a.id === agentId);
    if (agent) return { agent, project };
  }
  return null;
}

/** Live detail for one ref, as one viewer may see it. */
export interface ResolvedRef {
  kind: HubChatRefKind;
  targetId: string;
  /** False when the viewer cannot open the target (or it no longer exists). */
  visible: boolean;
  projectId: string | null;
  /** Canonical label for the chip: username, agent name, AH-12, acme#4, … */
  label: string | null;
  /** Secondary text: card or ticket title, PR title, session's agent. */
  title: string | null;
  /** Card column, PR status, session state, ticket status. */
  status: string | null;
  /** Session chips open in their agent; card chips carry their row id. */
  agentId: string | null;
  number: number | null;
}

function hidden(kind: HubChatRefKind, targetId: string): ResolvedRef {
  return {
    kind,
    targetId,
    visible: false,
    projectId: null,
    label: null,
    title: null,
    status: null,
    agentId: null,
    number: null,
  };
}

interface CardRow {
  id: string;
  title: string;
  short_id: number | null;
  card_prefix: string | null;
  project_id: string;
  column_name: string | null;
}

const CARD_SELECT = `
  SELECT c.id, c.title, c.short_id, b.card_prefix, b.project_id, col.name AS column_name
  FROM kanban_cards c
  JOIN kanban_boards b ON b.id = c.board_id
  LEFT JOIN kanban_columns col ON col.id = c.column_id`;

/** Resolves one ref as `viewer`. Never throws; a lookup failure reads as hidden. */
export function resolveRef(
  lookups: RefLookups,
  viewer: RefViewer,
  kind: HubChatRefKind,
  targetId: string,
): ResolvedRef {
  try {
    return resolveRefUnsafe(lookups, viewer, kind, targetId);
  } catch {
    return hidden(kind, targetId);
  }
}

function resolveRefUnsafe(
  lookups: RefLookups,
  viewer: RefViewer,
  kind: HubChatRefKind,
  targetId: string,
): ResolvedRef {
  const base = hidden(kind, targetId);
  const db = getDb();
  switch (kind) {
    case 'user': {
      if (!getMembershipRole(targetId, viewer.orgId)) return base;
      const user = getUserById(targetId);
      if (!user) return base;
      return { ...base, visible: true, label: user.username };
    }
    case 'agent': {
      const hit = findAgentInProjects(lookups, targetId);
      if (!hit || !visibleProject(lookups, viewer, hit.project.id)) return base;
      return {
        ...base,
        visible: true,
        projectId: hit.project.id,
        label: hit.agent.name,
        title: hit.project.name,
        agentId: hit.agent.id,
      };
    }
    case 'session': {
      const row = db
        .prepare(
          `SELECT id, agent_id, name, state FROM sessions
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(targetId) as
        | { id: string; agent_id: string; name: string; state: string | null }
        | undefined;
      if (!row) return base;
      const hit = findAgentInProjects(lookups, row.agent_id);
      if (!hit || !visibleProject(lookups, viewer, hit.project.id)) return base;
      if (!userCanReadSession(viewer.owner, row.id)) return base;
      return {
        ...base,
        visible: true,
        projectId: hit.project.id,
        label: row.name,
        title: hit.agent.name,
        status: row.state,
        agentId: row.agent_id,
      };
    }
    case 'card': {
      const row = db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(targetId) as CardRow | undefined;
      if (!row || !visibleProject(lookups, viewer, row.project_id)) return base;
      return {
        ...base,
        visible: true,
        projectId: row.project_id,
        label: formatCardShortId(row.card_prefix, row.short_id) ?? row.title,
        title: row.title,
        status: row.column_name,
      };
    }
    case 'ticket': {
      const row = db
        .prepare('SELECT id, project_id, subject, status FROM support_tickets WHERE id = ?')
        .get(targetId) as
        | { id: string; project_id: string; subject: string; status: string }
        | undefined;
      if (!row || !visibleProject(lookups, viewer, row.project_id)) return base;
      return {
        ...base,
        visible: true,
        projectId: row.project_id,
        label: row.subject || 'Support ticket',
        title: row.subject,
        status: row.status,
      };
    }
    case 'pr': {
      const target = parsePrTarget(targetId);
      if (!target || !visibleProject(lookups, viewer, target.projectId)) return base;
      const row = db
        .prepare(
          'SELECT number, title, status FROM pull_requests WHERE project_id = ? AND number = ?',
        )
        .get(target.projectId, target.number) as
        | { number: number; title: string; status: string }
        | undefined;
      if (!row) return base;
      return {
        ...base,
        visible: true,
        projectId: target.projectId,
        label: `${target.projectId}#${row.number}`,
        title: row.title,
        status: row.status,
        number: row.number,
      };
    }
    default:
      return base;
  }
}

/**
 * Re-resolves every token in a body as its author. Tokens the author cannot
 * see are flattened to their label; the rest are kept and returned as refs
 * (deduplicated, in first-seen order).
 */
export function resolveBodyRefs(
  lookups: RefLookups,
  author: RefViewer,
  body: string,
): { body: string; refs: HubChatRefInput[] } {
  const tokens = parseHubChatRefTokens(body, locateChatMarkdownCode);
  if (tokens.length === 0) return { body, refs: [] };
  const refs: HubChatRefInput[] = [];
  const seen = new Set<string>();
  const cache = new Map<string, ResolvedRef>();
  let out = '';
  let cursor = 0;
  for (const t of tokens) {
    const key = `${t.kind}:${t.targetId}`;
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = resolveRef(lookups, author, t.kind, t.targetId);
      cache.set(key, resolved);
    }
    out += body.slice(cursor, t.index);
    if (resolved.visible) {
      out += t.raw;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ kind: t.kind, targetId: t.targetId, projectId: resolved.projectId });
      }
    } else {
      // People and agents keep their `@`; everything else reads as its bare
      // label. Escaped just enough that the label renders as written and
      // forms no markup, while the raw body stays readable for editing.
      const text =
        t.kind === 'user' || t.kind === 'agent'
          ? hubChatRefDisplay(t.kind, t.label)
          : sanitizeHubChatRefLabel(t.label);
      out += escapeMarkdownText(text, isAtLineStart(body, t.index));
    }
    cursor = t.index + t.raw.length;
  }
  out += body.slice(cursor);
  // Store only refs that are still live in the body actually saved, so a
  // flattened neighbour can never leave a stored ref that does not render.
  const live = new Set(
    parseHubChatRefTokens(out, locateChatMarkdownCode).map((t) => `${t.kind}:${t.targetId}`),
  );
  return { body: out, refs: refs.filter((r) => live.has(`${r.kind}:${r.targetId}`)) };
}

/** One autocomplete row. `label` is what the composer inserts after the trigger. */
export interface RefSuggestion {
  kind: HubChatRefKind;
  targetId: string;
  label: string;
  detail: string | null;
  projectId: string | null;
}

const LIMIT = 8;
const SESSION_PAGE = 50;

function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * Autocomplete for the composer. `@` finds org members and agents in projects
 * the viewer can see; `#` finds cards (by `PREFIX-N` or title), sessions,
 * support tickets and native PRs (`project#N`, `#N` or title).
 */
export function searchRefs(
  lookups: RefLookups,
  viewer: RefViewer,
  trigger: '@' | '#',
  rawQuery: string,
): RefSuggestion[] {
  const q = rawQuery.trim().toLowerCase();
  const projects = lookups
    .getProjects()
    .filter((p) => !isSystemProject(p) && canViewProject(p, viewer.visibility));
  if (trigger === '@') {
    const users: RefSuggestion[] = listMembersForOrg(viewer.orgId)
      .filter((m) => !q || m.username.toLowerCase().includes(q))
      .map((m) => ({
        kind: 'user' as const,
        targetId: m.userId,
        label: m.username,
        detail: m.userId === viewer.userId ? 'You' : null,
        projectId: null,
      }));
    const agents: RefSuggestion[] = [];
    for (const p of projects) {
      for (const a of p.agents ?? []) {
        if (q && !a.name.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) continue;
        agents.push({
          kind: 'agent',
          targetId: a.id,
          label: a.name,
          detail: p.name,
          projectId: p.id,
        });
      }
    }
    return [...users.slice(0, LIMIT), ...agents].slice(0, LIMIT);
  }

  if (projects.length === 0) return [];
  const projectIds = projects.map((p) => p.id);
  const inProjects = placeholders(projectIds.length);
  const db = getDb();
  const out: RefSuggestion[] = [];

  // Cards: exact PREFIX-N first, then title / short-id matches.
  const shortMatch = /^([a-z0-9]+)-(\d+)$/i.exec(q);
  const cardRows: CardRow[] = [];
  if (shortMatch) {
    cardRows.push(
      ...(db
        .prepare(
          `${CARD_SELECT} WHERE b.project_id IN (${inProjects})
             AND UPPER(b.card_prefix) = ? AND c.short_id = ? LIMIT ?`,
        )
        .all(
          ...projectIds,
          shortMatch[1].toUpperCase(),
          Number(shortMatch[2]),
          LIMIT,
        ) as CardRow[]),
    );
  }
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  cardRows.push(
    ...(db
      .prepare(
        `${CARD_SELECT} WHERE b.project_id IN (${inProjects})
           AND (? = '' OR LOWER(c.title) LIKE ? ESCAPE '\\' OR c.short_id = ?)
         ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(...projectIds, q, likeArg(q), numeric ?? -1, LIMIT) as CardRow[]),
  );
  const seenCards = new Set<string>();
  for (const c of cardRows) {
    if (seenCards.has(c.id)) continue;
    seenCards.add(c.id);
    out.push({
      kind: 'card',
      targetId: c.id,
      label: formatCardShortId(c.card_prefix, c.short_id) ?? c.title,
      detail: c.title,
      projectId: c.project_id,
    });
  }

  // PRs: "project#N", "#N" / "N", or title.
  const prMatch = /^(?:([^#\s]+)#)?#?(\d+)$/.exec(q);
  const prRows = db
    .prepare(
      `SELECT project_id, number, title FROM pull_requests
       WHERE project_id IN (${inProjects})
         AND (? = '' OR LOWER(title) LIKE ? ESCAPE '\\' OR (number = ? AND (? = '' OR LOWER(project_id) = ?)))
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(
      ...projectIds,
      q,
      likeArg(q),
      prMatch ? Number(prMatch[2]) : -1,
      prMatch?.[1] ?? '',
      prMatch?.[1] ?? '',
      LIMIT,
    ) as { project_id: string; number: number; title: string }[];
  for (const r of prRows) {
    out.push({
      kind: 'pr',
      targetId: `${r.project_id}#${r.number}`,
      label: `${r.project_id}#${r.number}`,
      detail: r.title,
      projectId: r.project_id,
    });
  }

  // Tickets by subject.
  const ticketRows = db
    .prepare(
      `SELECT id, project_id, subject FROM support_tickets
       WHERE project_id IN (${inProjects}) AND (? = '' OR LOWER(subject) LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...projectIds, q, likeArg(q), LIMIT) as {
    id: string;
    project_id: string;
    subject: string;
  }[];
  for (const t of ticketRows) {
    out.push({
      kind: 'ticket',
      targetId: t.id,
      label: t.subject || 'Support ticket',
      detail: lookups.findProject(t.project_id)?.name ?? t.project_id,
      projectId: t.project_id,
    });
  }

  // Sessions by name, in the viewer's visible projects, that they can read.
  const agentProject = new Map<string, Project>();
  for (const p of projects) for (const a of p.agents ?? []) agentProject.set(a.id, p);
  const agentIds = [...agentProject.keys()];
  if (agentIds.length > 0) {
    // Readability (owner, reviewer, shared cron, org admin) is decided per
    // session, so page through matches until LIMIT readable ones are found or
    // the matches run out; a fixed window would hide a readable session behind
    // newer ones the viewer cannot open.
    const page = db.prepare(
      `SELECT id, agent_id, name FROM sessions
       WHERE deleted_at IS NULL AND agent_id IN (${placeholders(agentIds.length)})
         AND (? = '' OR LOWER(name) LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    );
    let added = 0;
    for (let offset = 0; added < LIMIT; offset += SESSION_PAGE) {
      const rows = page.all(...agentIds, q, likeArg(q), SESSION_PAGE, offset) as {
        id: string;
        agent_id: string;
        name: string;
      }[];
      for (const s of rows) {
        if (added >= LIMIT) break;
        if (!userCanReadSession(viewer.owner, s.id)) continue;
        added += 1;
        out.push({
          kind: 'session',
          targetId: s.id,
          label: s.name,
          detail: agentProject.get(s.agent_id)?.name ?? null,
          projectId: agentProject.get(s.agent_id)?.id ?? null,
        });
      }
      if (rows.length < SESSION_PAGE) break;
    }
  }

  // Interleave kinds so one busy kind cannot push the rest off the list.
  const byKind = new Map<HubChatRefKind, RefSuggestion[]>();
  for (const s of out) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  const merged: RefSuggestion[] = [];
  const queues = [...byKind.values()];
  while (merged.length < LIMIT * 2 && queues.some((qq) => qq.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) merged.push(next);
    }
  }
  return merged.slice(0, LIMIT * 2);
}
