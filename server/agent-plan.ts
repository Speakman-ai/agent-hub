/**
 * Lifts `<agenthub:plan>` blocks out of a live assistant stream into
 * `agent_plan` system messages so a human following the session sees the plan
 * (chat card + timeline marker) while the turn keeps running.
 */
import { randomUUID } from 'crypto';
import type { MessageRow, Stmts } from './types.js';
import type { BroadcastFn } from './react-loop-observability.js';
import { AGENT_PLAN_KIND, extractAgentPlanBlocks } from '../shared/utils/agentPlan.js';

export interface AgentPlanEmitterDeps {
  sessionId: string;
  stmts: Pick<Stmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast: BroadcastFn;
  newId?: () => string;
  log?: (msg: string) => void;
}

/**
 * Returns a function to call with the accumulated assistant text after each
 * chunk. Each distinct completed plan is written once per turn; partial-text
 * replays and buffer replacements that repeat a plan are ignored.
 */
export function createAgentPlanEmitter(deps: AgentPlanEmitterDeps): (text: string) => string[] {
  const seen = new Set<string>();
  const newId = deps.newId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});

  return (text: string) => {
    const written: string[] = [];
    for (const plan of extractAgentPlanBlocks(text)) {
      if (seen.has(plan)) continue;
      const messageId = newId();
      try {
        deps.stmts.addMessage.run(
          messageId,
          deps.sessionId,
          'system',
          `**Plan**\n\n${plan}`,
          null,
          null,
          null,
          JSON.stringify({ kind: AGENT_PLAN_KIND, plan }),
          null,
          null,
          null,
        );
      } catch (err) {
        log(
          `[agent-plan] addMessage failed session=${deps.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Left out of `seen` so the next chunk retries the insert.
        continue;
      }
      seen.add(plan);
      written.push(messageId);
      try {
        deps.stmts.touchSession.run(deps.sessionId);
      } catch {
        /* best-effort */
      }
      try {
        const inserted = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
        if (inserted) {
          deps.broadcast({ type: 'message', sessionId: deps.sessionId, message: inserted });
        }
      } catch (err) {
        log(
          `[agent-plan] broadcast failed session=${deps.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return written;
  };
}
