import {
  initialSidebarPanelState,
  sidebarPanelReducer,
  type SidebarAction,
  type SidebarPanelState,
} from './sessionSidebar.js';

/**
 * SideBar panel state, kept per parent session for the life of the app rather
 * than the life of a mounted pane. Hiding the SideBar, switching sessions, or
 * closing the mobile sheet must not lose what only this client knows (an
 * undelivered question, an operation still in flight), and an async result
 * that lands while no pane is mounted must still be applied.
 */
export interface SidebarStore {
  get: (parentSessionId: string) => SidebarPanelState;
  dispatch: (parentSessionId: string, action: SidebarAction) => void;
  subscribe: (parentSessionId: string, listener: () => void) => () => void;
  /** Unsent composer text per parent, so hiding the SideBar does not lose it. */
  getDraft: (parentSessionId: string) => string;
  setDraft: (parentSessionId: string, text: string) => void;
  /** Monotonic ids, unique across mounts: lookup tokens, op ids, question ids. */
  nextToken: () => number;
  nextOpId: () => number;
  nextQuestionId: () => string;
  /** Tests only. */
  clear: () => void;
}

export function createSidebarStore(): SidebarStore {
  const states = new Map<string, SidebarPanelState>();
  const listeners = new Map<string, Set<() => void>>();
  const drafts = new Map<string, string>();
  let token = 0;
  let opId = 0;
  let questionSeq = 0;

  const get = (parentSessionId: string): SidebarPanelState => {
    let state = states.get(parentSessionId);
    if (!state) {
      state = initialSidebarPanelState(parentSessionId);
      states.set(parentSessionId, state);
    }
    return state;
  };

  return {
    get,
    dispatch(parentSessionId, action) {
      const prev = get(parentSessionId);
      const next = sidebarPanelReducer(prev, action);
      if (next === prev) return;
      states.set(parentSessionId, next);
      for (const listener of [...(listeners.get(parentSessionId) ?? [])]) listener();
    },
    subscribe(parentSessionId, listener) {
      let set = listeners.get(parentSessionId);
      if (!set) {
        set = new Set();
        listeners.set(parentSessionId, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    getDraft: (parentSessionId) => drafts.get(parentSessionId) ?? '',
    setDraft(parentSessionId, text) {
      if (text) drafts.set(parentSessionId, text);
      else drafts.delete(parentSessionId);
    },
    nextToken: () => ++token,
    nextOpId: () => ++opId,
    nextQuestionId: () => `pending-${++questionSeq}`,
    clear() {
      states.clear();
      listeners.clear();
      drafts.clear();
    },
  };
}

/** The app-wide store (one per JS realm: the web app, or the mobile app). */
export const sidebarStore = createSidebarStore();
