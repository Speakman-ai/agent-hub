interface SkillLike {
  id: string;
  name: string;
  description?: string;
}

interface SkillRouteInput {
  message: string;
  skills: SkillLike[];
  agentId?: string;
  agentSystemPrompt?: string;
  cwd?: string;
  /**
   * Project slug (a.k.a. `project.id`) of the session that produced this
   * message. Used by the project-default rule (e.g. always inject the
   * `agent-hub` skill in agent-hub project sessions, even when the user's
   * message doesn't contain a platform tell).
   */
  projectSlug?: string;
}

export interface SkillRouteMatch {
  skillId: string;
  reason: string;
  score: number;
}

const THIRD_PARTY_KANBAN_RE = /\b(linear|jira|trello|asana|github projects?)\b/i;
const THIRD_PARTY_WIKI_RE = /\b(notion|confluence)\b/i;
const DESIGN_ARTIFACT_DIR_RE = /(?:^|\/)designs\/[^/]+\/?$/i;

/** Skills with dedicated `builtInScore` heuristics — skip bare-word `explicitMentionScore` for these ids so common English ("design", "kanban") does not hijack routing. */
const BUILT_IN_ROUTE_SKILL_IDS = new Set(
  ['kanban', 'wiki-search', 'using-git-worktrees', 'designs', 'design', 'agent-hub'].map((s) =>
    s.toLowerCase(),
  ),
);

function normalize(text: string): string {
  return text.toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(phrase.toLowerCase()).replace(/\s+/g, '\\s+')}\\b`, 'i');
}

function explicitMentionScore(message: string, skill: SkillLike): number {
  const raw = normalize(message);
  const id = skill.id.trim().toLowerCase();
  const name = (skill.name || '').trim().toLowerCase();
  if (!id && !name) return 0;

  const aliases = Array.from(new Set([id, name].filter(Boolean)));
  for (const alias of aliases) {
    const aliasRe = phraseRegex(alias);
    const allowBareAlias =
      alias.includes('-') ||
      alias.includes('_') ||
      alias.includes(' ') ||
      alias.length >= 12 ||
      // Short directory-style ids (e.g. `linear`) must still auto-route on a whole-word
      // mention. Excludes built-in ids whose names collide with common English.
      (alias.length >= 5 &&
        alias === id &&
        !BUILT_IN_ROUTE_SKILL_IDS.has(skill.id.trim().toLowerCase()));
    if (allowBareAlias && aliasRe.test(raw)) return 120;
    const withSkillWord = new RegExp(
      `\\b(?:use|load|trigger|route|invoke)\\s+${escapeRegExp(alias)}\\s+skill\\b`,
      'i',
    );
    if (withSkillWord.test(raw)) return 160;
    const dollarMention = new RegExp(`\\$${escapeRegExp(alias)}\\b`, 'i');
    if (dollarMention.test(raw)) return 170;
  }
  return 0;
}

function builtInScore(
  input: SkillRouteInput,
  skillId: string,
): { score: number; reason: string } | null {
  const message = normalize(input.message);
  const agentId = (input.agentId || '').trim().toLowerCase();
  const systemPrompt = normalize(input.agentSystemPrompt || '');
  const cwd = normalize(input.cwd || '');

  if (skillId === 'kanban') {
    if (THIRD_PARTY_KANBAN_RE.test(message) && !/\bagent hub\b/i.test(message)) return null;
    if (
      /\b(kanban|board|cards?|backlog|sprint|epic|move card|track work|task tracking|work items?)\b/i.test(
        message,
      )
    ) {
      return { score: 100, reason: 'kanban/board intent detected' };
    }
    return null;
  }

  if (skillId === 'wiki-search') {
    if (THIRD_PARTY_WIKI_RE.test(message) && !/\bagent hub\b/i.test(message)) return null;
    if (
      /\b(wiki|documentation|docs|architecture|conventions|search wiki|check wiki|project docs)\b/i.test(
        message,
      )
    ) {
      return { score: 95, reason: 'wiki/docs intent detected' };
    }
    return null;
  }

  if (skillId === 'using-git-worktrees') {
    if (
      /\b(worktree|worktrees|feature branch|separate workspace|isolated workspace|isolate)\b/i.test(
        message,
      )
    ) {
      return { score: 95, reason: 'worktree/isolation intent detected' };
    }
    return null;
  }

  if (skillId === 'designs') {
    if (
      /\b(design studio|designs|mockup|prototype|landing page|reference a design|screenshot a design|design artifact|design id)\b/i.test(
        message,
      )
    ) {
      return { score: 90, reason: 'design artifact read intent detected' };
    }
    return null;
  }

  if (skillId === 'design') {
    const isDesignSession =
      agentId === '__design_studio__' ||
      systemPrompt.includes('you are design studio') ||
      DESIGN_ARTIFACT_DIR_RE.test(cwd);
    return isDesignSession ? { score: 140, reason: 'design session context detected' } : null;
  }

  if (skillId === 'agent-hub') {
    if (
      /\b(agent hub|localhost:3051|\/api\/projects\/|agent_hub_url|agent_hub_api_key|agent_hub_session_id|project_id)\b/i.test(
        message,
      ) ||
      /<delegate>|<\/delegate>|<handoff>|<\/handoff>|<agenthub:close-card>/i.test(message) ||
      /scripts\/(board|wiki|kanban-[a-z-]+|heartbeats|crons|log-tool-error|epics|sessions|resolve-column-id|get-board-state|ah-api|server)\.sh\b/i.test(
        message,
      )
    ) {
      return { score: 110, reason: 'Agent Hub platform intent detected' };
    }
    if (THIRD_PARTY_KANBAN_RE.test(message) || THIRD_PARTY_WIKI_RE.test(message)) return null;
    return null;
  }

  return null;
}

/**
 * Return ALL matching skills for an input, sorted by descending score
 * (ties broken by skillId to keep ordering deterministic). Caller is
 * expected to load every match — this is what powers the "always-on
 * agent-hub skill in agent-hub project sessions" rule without dropping
 * the higher-intent kanban / wiki / worktree matches.
 *
 * De-duped by skillId: an explicit-trigger match for the same skill
 * always wins over the project-default match because the latter is
 * appended only when no candidate for that id already exists.
 */
export function routeSkillsFromMessage(input: SkillRouteInput): SkillRouteMatch[] {
  if (!input.message?.trim()) return [];
  if (/<agenthub:skill>/i.test(input.message)) return [];
  if (!Array.isArray(input.skills) || input.skills.length === 0) return [];

  const candidates: SkillRouteMatch[] = [];
  const seen = new Set<string>();
  for (const skill of input.skills) {
    if (!skill?.id || seen.has(skill.id)) continue;
    const explicit = explicitMentionScore(input.message, skill);
    const builtIn = builtInScore(input, skill.id);
    const score = explicit + (builtIn?.score || 0);
    if (score <= 0) continue;
    candidates.push({
      skillId: skill.id,
      reason:
        explicit > 0 && builtIn
          ? `explicit skill mention + ${builtIn.reason}`
          : explicit > 0
            ? 'explicit skill mention'
            : builtIn!.reason,
      score,
    });
    seen.add(skill.id);
  }

  // Project-default rule: always load the agent-hub skill in agent-hub
  // project sessions, even when the user's message contains no platform
  // tell. Score is intentionally lower than the explicit-trigger score
  // (110) so explicit user intent for other skills still wins on
  // ordering. Only append when no candidate for `agent-hub` already
  // exists — the explicit/built-in branch above is strictly better.
  if (
    input.projectSlug === 'agent-hub' &&
    !seen.has('agent-hub') &&
    input.skills.some((s) => s?.id === 'agent-hub')
  ) {
    candidates.push({
      skillId: 'agent-hub',
      reason: 'agent-hub project default',
      score: 30,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId));
  return candidates;
}

/**
 * Backwards-compatible single-match shim for older call sites and tests.
 * Returns the highest-scoring match or `null`. New code should call
 * {@link routeSkillsFromMessage} directly so every matched skill loads.
 */
export function routeSkillFromMessage(input: SkillRouteInput): SkillRouteMatch | null {
  return routeSkillsFromMessage(input)[0] ?? null;
}
