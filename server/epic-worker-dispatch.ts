/**
 * The seam between a manager's forward card and the worker it starts.
 *
 * A forward card an epic manager posts carries the kanban card it is for.
 * The card id is read from the manager's own message (via the card's dispatch
 * key), never from the request body, so whoever presses the card (a client
 * or the Auto start countdown) starts the worker for the card the manager
 * named. `server/index.ts` installs `spawnEpicWorkerForCard` as the starter;
 * the indirection keeps the dispatch route free of the autonomous module.
 */
import type { KanbanCardRow, KanbanEpicRow, MessageRow, SessionRow, Stmts } from './types.js';
import { parseSessionForwardDispatchKey } from '../shared/utils/sessionForwardDispatchKey.js';
import { forwardCardsForMessage } from './orchestrate-auto-start.js';
import type { SpawnEpicWorkerArgs, SpawnEpicWorkerResult } from './autonomous.js';

export type EpicWorkerStarter = (args: SpawnEpicWorkerArgs) => SpawnEpicWorkerResult;

let starter: EpicWorkerStarter | null = null;

export function setEpicWorkerStarter(fn: EpicWorkerStarter | null): void {
  starter = fn;
}

export function getEpicWorkerStarter(): EpicWorkerStarter | null {
  return starter;
}

export type EpicForwardResolution =
  /** The caller is not an epic manager: an ordinary dispatch. */
  | { kind: 'none' }
  /** An epic manager asked for something that is not a valid card forward. */
  | { kind: 'invalid'; error: string }
  | { kind: 'card'; epic: KanbanEpicRow; card: KanbanCardRow };

/**
 * What a dispatch from this calling session is. Only projects with
 * orchestrated epics have managers; elsewhere a forward's `cardId` is ignored
 * and the dispatch is an ordinary session. An epic manager may only
 * start workers for cards on its own epic, through its own forward cards;
 * anything else it asks for is refused rather than started as an untracked
 * session outside the epic's pause, hold, cap, and Finalize rules.
 */
export function resolveEpicForwardTarget(
  stmts: Pick<
    Stmts,
    | 'getEpicByManagerSession'
    | 'getMessageById'
    | 'getMessageSessionForwardEvents'
    | 'getKanbanCard'
  >,
  callingSession: Pick<SessionRow, 'id'> | null | undefined,
  dispatchKey: string | null | undefined,
  /** The project runs orchestrated epics; otherwise every dispatch is ordinary. */
  orchestrated: boolean,
): EpicForwardResolution {
  if (!orchestrated || !callingSession?.id) return { kind: 'none' };
  // Optional: partial statement sets (route tests) have no epic managers.
  const epic = stmts.getEpicByManagerSession?.get(callingSession.id) as KanbanEpicRow | undefined;
  if (!epic) return { kind: 'none' };
  const invalid = (error: string): EpicForwardResolution => ({ kind: 'invalid', error });
  const parsed = parseSessionForwardDispatchKey(dispatchKey);
  if (!parsed || parsed.sessionId !== callingSession.id) {
    return invalid('An epic manager starts workers only from its own forward cards');
  }
  const message = stmts.getMessageById.get(parsed.messageId) as MessageRow | undefined;
  if (!message || message.session_id !== callingSession.id) {
    return invalid('The forward card is not in this epic manager chat');
  }
  const forward = forwardCardsForMessage(stmts, callingSession.id, message).find(
    (card) => card.dispatchKey === dispatchKey,
  );
  const cardId = forward?.forward.cardId;
  if (!cardId) return invalid('The forward card names no kanban card (cardId)');
  const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
  if (!card || card.epic_id !== epic.id) {
    return invalid(`Card ${cardId} is not on epic "${epic.name}"`);
  }
  return { kind: 'card', epic, card };
}
