import {
  canAskSidebar,
  sidebarView,
  type SidebarAction,
  type SidebarView,
} from '../utils/sessionSidebar';
import {
  sidebarStore as defaultSidebarStore,
  type SidebarStore,
} from '../utils/sessionSidebarStore';

interface SidebarSessionRef {
  id: string;
  /** Per-parent creation order; lets a stale response lose to a newer SideBar. */
  sidebar_seq?: number | null;
}

export interface SidebarChatApi {
  getSessionSidebar: (parentSessionId: string) => Promise<{
    session: SidebarSessionRef | null;
    running?: boolean;
  }>;
  getMessages: (sessionId: string) => Promise<any[]>;
  openSessionSidebar: (
    parentSessionId: string,
    content?: string,
  ) => Promise<{ session: SidebarSessionRef; closedSessionIds?: string[] }>;
  closeSessionSidebar: (parentSessionId: string) => Promise<{ closedSessionIds?: string[] }>;
}

export interface SidebarChatOptions {
  parentSessionId: string;
  agentId: string;
  /** False while the surface is hidden; no lookup or subscription runs. */
  enabled: boolean;
  /**
   * WebSocket connection state. Events sent while disconnected are lost, so
   * a reconnect re-runs the lookup and history to reconcile (e.g. a turn that
   * finished while offline would otherwise stay "busy" forever).
   */
  connected: boolean;
  api: SidebarChatApi;
  /** WebSocket send. `false` means the frame was not sent. */
  send: (msg: Record<string, unknown>) => boolean | void;
  /** Subscribe to WS events routed to the SideBar; returns an unsubscribe. */
  subscribe: (cb: (data: any) => void) => () => void;
  /** Told whenever the current SideBar session id changes. */
  onSidebarSessionChange?: (parentSessionId: string, sidebarSessionId: string | null) => void;
  /** Where the panel state lives; defaults to the app-wide store. */
  store?: SidebarStore;
}

export type SidebarAskOutcome = 'sent' | 'undelivered' | 'rejected';

export interface SidebarChat {
  state: SidebarView;
  canAsk: boolean;
  /**
   * `sent`: on its way. `undelivered`: shown in the conversation, marked for
   * Retry. `rejected`: nothing was added (asking not allowed right now), so
   * the caller still holds the only copy of the text.
   */
  ask: (content: string) => Promise<SidebarAskOutcome>;
  /** Re-send an undelivered question in place. */
  retryQuestion: (questionId: string) => Promise<SidebarAskOutcome>;
  startFresh: () => Promise<void>;
  discard: () => Promise<void>;
  stop: () => void;
  retryLoad: () => void;
  /** Composer text, kept per parent in the store across mounts. */
  draft: string;
  setDraft: (next: string | ((current: string) => string)) => void;
}

type ReactHooks = {
  useCallback: <T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: readonly unknown[],
  ) => T;
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void];
};

const errMessage = (err: unknown, fallback: string): string => (err as Error)?.message || fallback;

// Web and native install different React versions. Use the renderer's own hooks.
export function createUseSidebarChat({ useCallback, useEffect, useRef, useState }: ReactHooks) {
  return function useSidebarChat(opts: SidebarChatOptions): SidebarChat {
    // api / send / onSidebarSessionChange are read through optsRef so async
    // work always uses the latest callbacks without re-running effects.
    const { parentSessionId, agentId, enabled, connected, subscribe } = opts;
    // State lives in the store, keyed by parent, so it outlives this mount;
    // async results dispatch there even after the pane is hidden.
    const store = opts.store ?? defaultSidebarStore;
    const [state, setState] = useState(() => store.get(parentSessionId));
    useEffect(() => {
      setState(store.get(parentSessionId));
      return store.subscribe(parentSessionId, () => setState(store.get(parentSessionId)));
    }, [store, parentSessionId]);
    const dispatch = useCallback(
      (action: SidebarAction) => store.dispatch(parentSessionId, action),
      [store, parentSessionId],
    );
    const [draft, setDraftState] = useState(() => store.getDraft(parentSessionId));
    useEffect(() => {
      setDraftState(store.getDraft(parentSessionId));
    }, [store, parentSessionId]);
    const setDraft = useCallback(
      (next: string | ((current: string) => string)) => {
        const value = typeof next === 'function' ? next(store.getDraft(parentSessionId)) : next;
        store.setDraft(parentSessionId, value);
        setDraftState(value);
      },
      [store, parentSessionId],
    );
    /** Always the latest state, never a render behind. */
    const current = useCallback(() => store.get(parentSessionId), [store, parentSessionId]);
    const [reloadNonce, setReloadNonce] = useState(0);
    const wasConnectedRef = useRef(connected);
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const view = sidebarView(state);

    useEffect(() => {
      if (!enabled) return;
      return subscribe((data) => dispatch({ type: 'ws', data }));
    }, [enabled, subscribe, dispatch]);

    const load = useCallback(() => {
      const token = store.nextToken();
      dispatch({ type: 'load_start', token, parentSessionId });
      void (async () => {
        let session: { id: string; sidebar_seq?: number | null } | null;
        let running: boolean | undefined;
        try {
          ({ session, running } = await optsRef.current.api.getSessionSidebar(parentSessionId));
        } catch (err) {
          dispatch({ type: 'load_failed', token, error: errMessage(err, 'Failed to load') });
          return;
        }
        const sidebarId = session?.id ?? null;
        dispatch({
          type: 'load_result',
          token,
          sidebarId,
          seq: session?.sidebar_seq ?? null,
          running: !!running,
        });
        if (!sidebarId) return;
        try {
          const messages = await optsRef.current.api.getMessages(sidebarId);
          dispatch({ type: 'history', token, sidebarId, messages });
        } catch (err) {
          dispatch({
            type: 'history_failed',
            token,
            sidebarId,
            error: errMessage(err, 'Failed to load the conversation'),
          });
        }
      })();
    }, [parentSessionId, dispatch, store]);

    useEffect(() => {
      if (!enabled) return;
      load();
    }, [enabled, load, reloadNonce]);

    useEffect(() => {
      const wasConnected = wasConnectedRef.current;
      wasConnectedRef.current = connected;
      if (enabled && connected && !wasConnected) load();
    }, [enabled, connected, load]);

    useEffect(() => {
      optsRef.current.onSidebarSessionChange?.(parentSessionId, view.sidebarId);
    }, [parentSessionId, view.sidebarId]);

    /**
     * Send a question that is already in the conversation (just added, or an
     * undelivered one being retried). On failure the reducer marks that same
     * message undelivered, so its text is never lost.
     */
    const deliver = useCallback(
      async (questionId: string, content: string): Promise<SidebarAskOutcome> => {
        const sidebarId = current().conv.id;
        if (sidebarId) {
          const sent = optsRef.current.send({
            type: 'chat',
            agentId,
            sessionId: sidebarId,
            content,
          });
          if (sent === false) {
            dispatch({ type: 'ask_failed', questionId, error: 'Not connected. Try again.' });
            return 'undelivered';
          }
          return 'sent';
        }
        const opId = store.nextOpId();
        dispatch({ type: 'op_start', opId, op: 'open', questionId });
        try {
          const res = await optsRef.current.api.openSessionSidebar(parentSessionId, content);
          dispatch({
            type: 'op_opened',
            opId,
            sidebarId: res.session.id,
            seq: res.session.sidebar_seq ?? null,
            closedIds: res.closedSessionIds ?? [],
          });
          return 'sent';
        } catch (err) {
          dispatch({
            type: 'op_failed',
            opId,
            error: errMessage(err, 'Could not open the SideBar'),
          });
          return 'undelivered';
        }
      },
      [agentId, parentSessionId, current, dispatch, store],
    );

    const ask = useCallback(
      async (raw: string): Promise<SidebarAskOutcome> => {
        const content = raw.trim();
        if (!content || !canAskSidebar(current())) return 'rejected';
        const questionId = store.nextQuestionId();
        dispatch({ type: 'ask_local', questionId, content });
        return deliver(questionId, content);
      },
      [deliver, current, dispatch, store],
    );

    const retryQuestion = useCallback(
      async (questionId: string): Promise<SidebarAskOutcome> => {
        const now = current();
        const msg = now.conv.messages.find((m) => m.id === questionId && m.failed);
        if (!msg || !canAskSidebar(now)) return 'rejected';
        dispatch({ type: 'question_retry', questionId });
        return deliver(questionId, msg.content);
      },
      [deliver, current, dispatch],
    );

    const startFresh = useCallback(async () => {
      const now = current();
      const v = sidebarView(now);
      if (v.phase !== 'ready' || now.pendingOp || v.busy) return;
      const opId = store.nextOpId();
      dispatch({ type: 'op_start', opId, op: 'fresh' });
      try {
        const res = await optsRef.current.api.openSessionSidebar(parentSessionId);
        dispatch({
          type: 'op_opened',
          opId,
          sidebarId: res.session.id,
          seq: res.session.sidebar_seq ?? null,
          closedIds: res.closedSessionIds ?? [],
        });
      } catch (err) {
        dispatch({
          type: 'op_failed',
          opId,
          error: errMessage(err, 'Could not start a new SideBar'),
        });
      }
    }, [parentSessionId, current, dispatch, store]);

    const discard = useCallback(async () => {
      const now = current();
      if (sidebarView(now).phase !== 'ready' || now.pendingOp) return;
      const opId = store.nextOpId();
      dispatch({ type: 'op_start', opId, op: 'discard' });
      try {
        const res = await optsRef.current.api.closeSessionSidebar(parentSessionId);
        dispatch({ type: 'op_discarded', opId, closedIds: res?.closedSessionIds ?? [] });
      } catch (err) {
        dispatch({
          type: 'op_failed',
          opId,
          error: `Could not discard the SideBar: ${errMessage(err, 'request failed')}. Try again.`,
        });
      }
    }, [parentSessionId, current, dispatch, store]);

    const stop = useCallback(() => {
      const id = current().conv.id;
      if (id) optsRef.current.send({ type: 'cancel', sessionId: id });
    }, [current]);

    const retryLoad = useCallback(() => setReloadNonce((n) => n + 1), []);

    return {
      state: view,
      canAsk: canAskSidebar(state),
      ask,
      retryQuestion,
      startFresh,
      discard,
      stop,
      retryLoad,
      draft,
      setDraft,
    };
  };
}
