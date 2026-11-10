/**
 * Title hooks for the publish paths: who the keyless PR-title model runs as,
 * and what happens to the session and card once the PR title is known.
 */
import { adoptShippedTitle } from '../auto-title-sync.js';
import { getSessionOwner } from '../session-ownership.js';
import { createCliTitleCompleter } from '../title-completer.js';
import type { TitleCompleter } from '../session-title.js';
import type { AppConfig, BroadcastFn, Stmts } from '../types.js';

export interface PrTitleHooks {
  /** Completer on the session owner's engine login, or null with no owner. */
  titleCompleterFor: (args: {
    sessionId?: string | null;
    authorUserId?: string | null;
  }) => TitleCompleter | null;
  /** Copy the final PR title onto an auto-named session and auto-derived card. */
  onPrTitle: (args: { sessionId?: string | null; title: string }) => void;
}

export function createPrTitleHooks(deps: {
  config: AppConfig;
  stmts: Stmts;
  broadcast: BroadcastFn;
}): PrTitleHooks {
  return {
    titleCompleterFor: ({ sessionId, authorUserId }) =>
      createCliTitleCompleter(
        deps.config,
        authorUserId ?? (sessionId ? getSessionOwner(sessionId) : null),
      ),
    onPrTitle: ({ sessionId, title }) => {
      if (!sessionId) return;
      try {
        adoptShippedTitle({ stmts: deps.stmts, broadcast: deps.broadcast }, sessionId, title);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pr-title] failed to adopt PR title for session ${sessionId}: ${msg}`);
      }
    },
  };
}
