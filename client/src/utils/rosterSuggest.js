/**
 * Agent roster suggestion — pure logic for mapping project tracks to
 * existing Agent Hub agents.
 *
 * After the post-scaffold audit, we surface a shortlist of role tracks
 * ("architect", "backend", "QA", "DevEx", "deploy") and let the user
 * bind each to an existing agent (or skip). The bindings are persisted
 * on the project record so autonomous dispatch has a roster to target.
 *
 * This module is deliberately separate from fetch/transport — it's pure
 * mapping logic so tests can drive it with plain objects.
 */

/** Default tracks shown when the server's suggestion endpoint is offline or
 *  returns an empty list. Ordered by typical project-kickoff priority. */
export const DEFAULT_TRACKS = [
  {
    id: 'architect',
    label: 'Architect',
    rationale: 'Owns high-level design decisions and sequencing.',
    keywords: ['lead', 'architect', 'design', 'cto'],
  },
  {
    id: 'backend',
    label: 'Backend',
    rationale: 'Implements server, database, and API work.',
    keywords: ['backend', 'server', 'api', 'node'],
  },
  {
    id: 'frontend',
    label: 'Frontend',
    rationale: 'Owns the client UI, styling, and real-time integration.',
    keywords: ['frontend', 'client', 'ui', 'react', 'web'],
  },
  {
    id: 'qa',
    label: 'QA',
    rationale: 'Reviews, runs tests, and validates releases.',
    keywords: ['qa', 'test', 'review', 'reviewer'],
  },
  {
    id: 'devex',
    label: 'DevEx',
    rationale: 'Tooling, CI/CD, and developer experience.',
    keywords: ['devex', 'tooling', 'ci', 'cd', 'ops'],
  },
  {
    id: 'deploy',
    label: 'Deploy',
    rationale: 'Infrastructure, AWS, and release operations.',
    keywords: ['deploy', 'ops', 'aws', 'infra', 'sre'],
  },
];

/**
 * Given a list of available agents (from GET /api/agents) and a list of
 * tracks, suggest an `agentId` for each track by matching keywords against
 * the agent's `name`, `role`, and `tags`. First match wins per track; an
 * agent suggested for one track is still eligible for others (users pick).
 *
 * Returns a new array — input tracks are not mutated.
 */
export function suggestRoster({ tracks = DEFAULT_TRACKS, agents = [] } = {}) {
  return tracks.map((track) => {
    const match = agents.find((agent) => matchesTrack(agent, track));
    return {
      id: track.id,
      label: track.label,
      rationale: track.rationale,
      keywords: track.keywords || [],
      suggestedAgentId: match ? match.id : null,
    };
  });
}

function matchesTrack(agent, track) {
  if (!agent || typeof agent !== 'object') return false;
  const haystack = [
    agent.id,
    agent.name,
    agent.role,
    Array.isArray(agent.tags) ? agent.tags.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const keywords = track.keywords || [];
  return keywords.some((kw) => kw && haystack.includes(kw.toLowerCase()));
}

/**
 * Initial roster state for the picker — one row per suggested track with
 * the suggested agent pre-selected. Users can override each row or mark
 * it "skip".
 */
export function initialRoster(suggestions = []) {
  return suggestions.map((s) => ({
    trackId: s.id,
    label: s.label,
    rationale: s.rationale,
    agentId: s.suggestedAgentId || null,
    agentName: '',
    // `custom` lets the user mark a bespoke track the server didn't suggest.
    custom: false,
  }));
}

/** Default display name for a newly created per-track agent. */
export function defaultAgentName(projectName, trackLabel) {
  const base = (projectName || 'Project').trim() || 'Project';
  const label = (trackLabel || '').trim();
  return label ? `${base} ${label}` : base;
}

/**
 * Post-scaffold roster rows — each track gets a new agent name; no binding
 * to existing org agents.
 */
export function initialRosterForCreate(suggestions = [], projectName = '') {
  return suggestions.map((s) => ({
    trackId: s.id,
    label: s.label,
    rationale: s.rationale,
    agentId: null,
    agentName: defaultAgentName(projectName, s.label),
    custom: true,
  }));
}

/**
 * Immutable update helper — assign / clear an agent for a given track id.
 * Pass `null` to clear.
 */
export function setRosterAgent(roster, trackId, agentId) {
  return roster.map((row) => (row.trackId === trackId ? { ...row, agentId } : row));
}

/** Update the display name for a track's new agent (create flow). */
export function setRosterAgentName(roster, trackId, agentName) {
  return roster.map((row) => (row.trackId === trackId ? { ...row, agentName } : row));
}

/**
 * Append a custom track to the roster. Returns a new roster with the row
 * placed at the end. `id` should be unique — typically `custom-<timestamp>`.
 */
export function addCustomTrack(roster, { id, label }, projectName = '') {
  if (!id || !label) return roster;
  if (roster.some((r) => r.trackId === id)) return roster;
  return [
    ...roster,
    {
      trackId: id,
      label,
      rationale: 'Custom track',
      agentId: null,
      agentName: defaultAgentName(projectName, label),
      custom: true,
    },
  ];
}

/** Remove a row — only custom rows can be removed through the UI. */
export function removeRosterTrack(roster, trackId) {
  return roster.filter((r) => r.trackId !== trackId);
}

/**
 * Convert the UI roster into the compact `{tracks:[{id, agentId}]}` payload
 * the persistence endpoint expects. Rows with `agentId === null` are kept
 * as "declared but unassigned" tracks so the backend can still persist the
 * shape of the team. Empty-label custom rows are filtered out.
 */
export function rosterToPayload(roster = [], { createAgents = false } = {}) {
  return {
    tracks: roster
      .filter((r) => r.label && r.trackId)
      .filter((r) => {
        if (!createAgents) return true;
        return (r.agentName || '').trim().length > 0;
      })
      .map((r) => {
        if (createAgents || r.custom) {
          return {
            id: r.trackId,
            label: r.label,
            agentName: (r.agentName || r.label).trim(),
            custom: true,
          };
        }
        return {
          id: r.trackId,
          label: r.label,
          agentId: r.agentId || null,
          custom: !!r.custom,
        };
      }),
  };
}

/** True when at least one track has an assigned agent. Used to enable the
 *  "Confirm roster" button — an all-null roster isn't useful. */
export function hasAnyAssignment(roster = []) {
  return roster.some((r) => !!r.agentId);
}

/** True when at least one track has a non-empty new-agent name (create flow). */
export function hasAnyNamedAgent(roster = []) {
  return roster.some((r) => (r.agentName || '').trim().length > 0);
}
