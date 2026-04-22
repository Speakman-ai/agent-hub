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
}

export interface SkillRouteMatch {
  skillId: string;
  reason: string;
  score: number;
}

const THIRD_PARTY_KANBAN_RE = /\b(linear|jira|trello|asana|github projects?)\b/i;
const THIRD_PARTY_WIKI_RE = /\b(notion|confluence)\b/i;
const DESIGN_ARTIFACT_DIR_RE = /(?:^|\/)designs\/[^/]+\/?$/i;

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
      alias.includes('-') || alias.includes('_') || alias.includes(' ') || alias.length >= 12;
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
      /<delegate>|<\/delegate>|<handoff>|<\/handoff>|<agenthub:close-card>/i.test(message)
    ) {
      return { score: 110, reason: 'Agent Hub platform intent detected' };
    }
    if (THIRD_PARTY_KANBAN_RE.test(message) || THIRD_PARTY_WIKI_RE.test(message)) return null;
    return null;
  }

  return null;
}

export function routeSkillFromMessage(input: SkillRouteInput): SkillRouteMatch | null {
  if (!input.message?.trim()) return null;
  if (/<agenthub:skill>/i.test(input.message)) return null;
  if (!Array.isArray(input.skills) || input.skills.length === 0) return null;

  const candidates: SkillRouteMatch[] = [];
  for (const skill of input.skills) {
    if (!skill?.id) continue;
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
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId));
  return candidates[0] || null;
}
