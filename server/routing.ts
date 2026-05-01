import type { Agent, KanbanCardRow, Project } from './types.js';

// ─── Label-based routing ─────────────────────────────────────────────────────
//
// Replaces the synchronous triage step with a stateless label-match: the
// intake agent stamps labels on the card at intake time, and the autonomous
// dispatcher routes the card to the first specialist whose `id`, `role`, or
// `name` matches one of those labels (case-insensitive). When no specialist
// matches, the card falls through to the project lead, who can implement
// directly or `<handoff>` to a sub-agent.
//
// Pure — no DB / no broadcast. Tested in routing.test.ts.

/** Split a comma-separated label string into a normalized lower-case array. */
export function parseLabels(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Does this agent claim ownership of `label`? True when the (lowercased)
 * label exactly matches the agent's `id`, `role`, or `name`, or the tail of
 * a hyphenated id (e.g. `hub-frontend` → also matches the label `frontend`).
 */
export function agentClaimsLabel(agent: Agent, label: string): boolean {
  const norm = label.trim().toLowerCase();
  if (!norm) return false;
  if (agent.id?.toLowerCase() === norm) return true;
  if (typeof agent.role === 'string' && agent.role.toLowerCase() === norm) return true;
  if (agent.name?.toLowerCase() === norm) return true;
  // `hub-frontend` / `agent-hub-backend` both expose a tail segment after
  // the leading qualifier — e.g. `frontend`, `backend`. Operators commonly
  // tag cards with the tail rather than the fully-qualified id, so we
  // accept it here.
  const idLower = agent.id?.toLowerCase();
  if (idLower) {
    const parts = idLower.split('-');
    if (parts.length > 1) {
      const tail = parts.slice(1).join('-');
      if (tail === norm) return true;
    }
  }
  return false;
}

export interface RoutingPickContext {
  /** Slot accounting from the dispatcher: agent-id → remaining slots. */
  slotsByAgentId: Map<string, number>;
}

/**
 * Pick the agent that should pick up `card`. Resolution order:
 *   1. The first label on the card whose id/role/name/tail matches a
 *      specialist with available slots.
 *   2. The project lead, if it has slots.
 *   3. (Lead-less projects only) The first specialist in `assignableAgents`
 *      with available slots — preserves the historical round-robin-style
 *      behavior of pre-routing autonomous mode for projects that never had
 *      a lead defined.
 *   4. null — caller should defer the card to the next dispatch tick.
 *
 * `assignableAgents` is the dispatcher's pool (already filtered for out-of-
 * band roles like docs/intake/reviewer). `lead` is optional — when omitted
 * the function does NOT use it as fallback.
 *
 * IMPORTANT: this function does NOT decrement slots; the caller is
 * responsible for that after a successful pick. Keeping it pure makes the
 * routing decision easy to unit-test and reason about.
 */
export function pickAgentForCard(args: {
  card: Pick<KanbanCardRow, 'labels'>;
  assignableAgents: Agent[];
  lead: Agent | null;
  ctx: RoutingPickContext;
}): Agent | null {
  const { card, assignableAgents, lead, ctx } = args;
  const labels = parseLabels(card.labels ?? null);

  // 1. Walk labels in order; first agent with capacity wins. We iterate
  // labels (not agents) so that label order on the card encodes priority
  // when the intake stamps multiple specialty labels.
  for (const label of labels) {
    for (const agent of assignableAgents) {
      if (!agentClaimsLabel(agent, label)) continue;
      const slots = ctx.slotsByAgentId.get(agent.id) ?? 0;
      if (slots > 0) return agent;
    }
  }

  // 2. Fallback: project lead. The lead is allowed to take work directly
  // and can `<handoff>` to a sub-agent if it would rather route the card.
  if (lead) {
    const slots = ctx.slotsByAgentId.get(lead.id) ?? 0;
    if (slots > 0) return lead;
  } else {
    // 3. No lead configured — pick the first specialist with capacity so
    // unconfigured / lead-less projects don't silently halt on cards that
    // don't carry a routing label.
    for (const agent of assignableAgents) {
      const slots = ctx.slotsByAgentId.get(agent.id) ?? 0;
      if (slots > 0) return agent;
    }
  }

  return null;
}

/**
 * Convenience: extract the project lead. Out-of-band roles (docs, intake,
 * reviewer) are never returned even if labelled `lead`.
 */
export function pickLead(project: Project): Agent | null {
  const agents = project.agents || [];
  const lead = agents.find((a) => a.role === 'lead');
  return lead ?? null;
}
