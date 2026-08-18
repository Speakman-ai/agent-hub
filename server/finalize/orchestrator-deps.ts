/**
 * orchestrator-deps.ts — build a production {@link OrchestratorDeps}
 * bundle from the route-layer {@link RouteDeps} singleton.
 */
import { getDb } from '../db.js';
import { createCardLifecycle } from './card-lifecycle.js';
import { createDispatchAndWaitForTurnEnd } from './dispatch-and-wait.js';
import { createPushAndCreatePr } from './push-and-create-pr.js';
import type { CancelSignal, FixDispatchTrigger } from './fix-dispatch.js';
import type { RunReviewerOnLocalDiff } from './reviewer-dispatch.js';
import { createInSessionReviewer } from './in-session-reviewer.js';
import { finalizeTurnEndSubscriber } from './turn-end.js';
import { createSpawnFinalizeFixTurn } from './spawn-fix-turn.js';
import { buildEnrichedPrompt } from '../chat.js';
import { createFinalizeStepLogStore } from './finalize-log-store.js';
import type { OrchestratorDeps } from './orchestrator.js';
import type { EnrichedAgent, KanbanCardRow, RouteDeps } from '../types.js';
import { waitForPreFinalizeBackgroundShells } from './pre-finalize-background-shells.js';

// ─── Stub seams (tests only) ─────────────────────────────────────────

const stubRunReviewer: RunReviewerOnLocalDiff = async () => {
  throw new Error(
    '[finalize] stubRunReviewer invoked — production wiring should use createInSessionReviewer.',
  );
};

const stubTurnEnd = finalizeTurnEndSubscriber;

async function stubDispatchAndWaitForTurnEnd(_args: {
  sessionId: string;
  cardId: string;
  body: string;
}): Promise<{ userMessagePersisted: boolean }> {
  throw new Error(
    '[finalize] dispatchAndWaitForTurnEnd not wired — production should use createDispatchAndWaitForTurnEnd.',
  );
}

// ─── Public API ────────────────────────────────────────────────────────

export function buildOrchestratorDeps(
  routeDeps: RouteDeps,
  card: KanbanCardRow,
  projectId: string,
): OrchestratorDeps {
  const runReviewer = createInSessionReviewer({
    stmts: routeDeps.stmts,
    broadcast: routeDeps.broadcast,
    getEnrichedAgent: routeDeps.getEnrichedAgent,
    findAgent: routeDeps.findAgent,
    buildEnrichedPrompt: (agent: EnrichedAgent): string => {
      const lookup = routeDeps.findAgent(agent.id);
      if (lookup?.project) {
        return buildEnrichedPrompt(lookup.project, agent, {
          useWorktree: false,
          isFirstMessage: false,
          omitDevLifecycle: true,
          _getEnrichedAgent: routeDeps.getEnrichedAgent,
        });
      }
      return buildEnrichedPrompt(agent, undefined, {
        useWorktree: false,
        isFirstMessage: false,
        omitDevLifecycle: true,
      });
    },
    getClaudeBin: routeDeps.getClaudeBin,
    getCursorBin: routeDeps.getCursorBin ?? (() => 'cursor-agent'),
    getGeminiBin: routeDeps.getGeminiBin ?? (() => 'gemini'),
    getCodexBin: routeDeps.getCodexBin ?? (() => 'codex'),
    getGrokBin: routeDeps.getGrokBin ?? (() => 'grok'),
    getConfig: () => routeDeps.config,
    activeProcesses: routeDeps.activeProcesses,
  });

  // One spawn helper, shared by both dispatch seams: the fix-dispatch loop
  // (failed step / reviewer changes) and the rebase-conflict dispatch. Both
  // must actually trigger the session agent — otherwise the run hangs on a
  // turn-end that never fires until the active-time budget expires.
  const spawnFixTurn = createSpawnFinalizeFixTurn({
    stmts: routeDeps.stmts,
    findAgent: routeDeps.findAgent,
    handleChat: routeDeps.handleChat,
  });

  const dispatchAndWaitForTurnEnd = createDispatchAndWaitForTurnEnd({
    stmts: routeDeps.stmts,
    broadcast: routeDeps.broadcast,
    turnEnd: finalizeTurnEndSubscriber,
    spawnTurn: spawnFixTurn,
  });

  return {
    config: routeDeps.config,
    stmts: routeDeps.stmts,
    broadcast: routeDeps.broadcast,
    logStore: createFinalizeStepLogStore(routeDeps.config),
    transactional: <T>(fn: () => T): T => getDb().transaction(fn)(),
    runReviewer,
    turnEnd: finalizeTurnEndSubscriber,
    pushAndCreatePr: createPushAndCreatePr({
      config: routeDeps.config,
      nativePr: routeDeps.nativePr,
    }),
    dispatchAndWaitForTurnEnd,
    spawnFixTurn,
    cardLifecycle: createCardLifecycle(
      { stmts: routeDeps.stmts, broadcast: routeDeps.broadcast },
      { cardId: card.id, projectId, moveToDoneOnPush: routeDeps.config.cardDoneOnPush !== false },
    ),
    waitForBackgroundShells: async ({ sessionId, signal }) =>
      waitForPreFinalizeBackgroundShells(routeDeps, sessionId, { signal }),
  };
}

export const __test = {
  stubRunReviewer,
  stubTurnEnd,
  stubDispatchAndWaitForTurnEnd,
};

export type { CancelSignal, FixDispatchTrigger };
