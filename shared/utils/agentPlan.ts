/**
 * Mid-turn plan announcements. The agent emits a naked
 * `<agenthub:plan>…</agenthub:plan>` block before it starts editing; the server
 * pulls each completed block out of the live stream, writes it as an
 * `agent_plan` system message, and the turn keeps running. The block itself is
 * stripped from the assistant reply (see stripAssistantControlBlocks).
 */
import { closeTagPatternSource, openTagPatternSource } from './controlTagPattern.js';

export const AGENT_PLAN_KIND = 'agent_plan';
export const AGENT_PLAN_TAG = 'agenthub:plan';
/** Plans longer than this are cut so one block can't flood the timeline. */
export const AGENT_PLAN_MAX_CHARS = 4000;

const PLAN_BLOCK_RE = new RegExp(
  `${openTagPatternSource(AGENT_PLAN_TAG)}([\\s\\S]*?)${closeTagPatternSource(AGENT_PLAN_TAG)}`,
  'gi',
);

/** Every completed plan block in `text`, trimmed, in order. Empty blocks are skipped. */
export function extractAgentPlanBlocks(text: string | null | undefined): string[] {
  if (!text || !text.includes(`<${AGENT_PLAN_TAG}>`)) return [];
  const plans: string[] = [];
  for (const match of text.matchAll(PLAN_BLOCK_RE)) {
    const body = (match[1] ?? '').trim();
    if (!body) continue;
    plans.push(
      body.length > AGENT_PLAN_MAX_CHARS ? `${body.slice(0, AGENT_PLAN_MAX_CHARS - 1)}…` : body,
    );
  }
  return plans;
}

export interface AgentPlanMeta {
  plan: string;
}

export function parseAgentPlanMetadata(metadata: unknown): AgentPlanMeta | null {
  if (metadata == null) return null;
  let parsed: unknown;
  try {
    parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== AGENT_PLAN_KIND || typeof obj.plan !== 'string' || !obj.plan.trim()) {
    return null;
  }
  return { plan: obj.plan };
}

export function agentPlanAnchorId(messageId: string): string {
  return `plan:${messageId}`;
}
