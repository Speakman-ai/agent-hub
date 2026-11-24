import {
  withSessionFolder,
  withoutSessionFolder,
  type SessionFolderListingWire,
  type SessionFolderWire,
} from '../utils/sessionFolders';

/** The REST calls the hook needs; web and mobile pass their own `api`. */
export interface SessionFoldersApi {
  getSessionFolders(agentId: string): Promise<SessionFolderListingWire>;
  createSessionFolder(agentId: string, name: string): Promise<{ folder: SessionFolderWire }>;
  renameSessionFolder(folderId: string, name: string): Promise<unknown>;
  deleteSessionFolder(folderId: string): Promise<unknown>;
  setSessionFolder(sessionId: string, folderId: string | null): Promise<unknown>;
}

export type SessionFoldersByAgentId = Record<string, SessionFolderListingWire>;

type Hooks = {
  useState: <T>(initial: T) => [T, (next: T | ((prev: T) => T)) => void];
  useRef: <T>(initial: T) => { current: T };
  useCallback: <F extends (...args: any[]) => any>(fn: F, deps: readonly unknown[]) => F;
};

/**
 * The caller's sidebar folders, cached per agent. Loads lazily (once per agent)
 * and applies writes optimistically.
 *
 * Every request for an agent, load or write, runs through one per-agent queue,
 * so the server sees writes in the order the user made them and the final
 * optimistic state matches what is stored. A load result is applied only when
 * no write for that agent is pending; otherwise it would overwrite optimistic
 * state, so it is dropped and the agent is fetched again once its writes
 * drain. A failed write also triggers that refetch.
 */
// Web and native install different React versions. Use the renderer's own hooks.
export function createUseSessionFolders({ useState, useRef, useCallback }: Hooks) {
  return function useSessionFolders(api: SessionFoldersApi) {
    const [foldersByAgentId, setFoldersByAgentId] = useState<SessionFoldersByAgentId>({});
    const requested = useRef(new Set<string>());
    const queues = useRef<Record<string, Promise<void>>>({});
    const pendingWrites = useRef<Record<string, number>>({});
    const refetchWanted = useRef(new Set<string>());

    const enqueue = useCallback(<T>(agentId: string, task: () => Promise<T>): Promise<T> => {
      const run = (queues.current[agentId] ?? Promise.resolve()).then(task);
      queues.current[agentId] = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }, []);

    const fetchAgent = useCallback(
      (agentId: string): Promise<void> =>
        enqueue(agentId, async () => {
          let listing: SessionFolderListingWire;
          try {
            listing = await api.getSessionFolders(agentId);
          } catch (err) {
            requested.current.delete(agentId);
            console.warn('[session-folders] load failed', err);
            return;
          }
          if ((pendingWrites.current[agentId] ?? 0) > 0) {
            refetchWanted.current.add(agentId);
            return;
          }
          setFoldersByAgentId((prev) => ({ ...prev, [agentId]: listing }));
        }),
      [api, enqueue],
    );

    const loadFolders = useCallback(
      (agentId: string) => {
        if (!agentId || requested.current.has(agentId)) return;
        requested.current.add(agentId);
        void fetchAgent(agentId);
      },
      [fetchAgent],
    );

    const update = useCallback(
      (agentId: string, fn: (l: SessionFolderListingWire) => SessionFolderListingWire) =>
        setFoldersByAgentId((prev) => {
          const current = prev[agentId] ?? { folders: [], assignments: {} };
          return { ...prev, [agentId]: fn(current) };
        }),
      [],
    );

    /**
     * Queues one write for an agent. The pending count rises synchronously so
     * a load already in the queue cannot land over the caller's optimistic
     * update. Resolves to null on failure.
     */
    const write = useCallback(
      <T>(agentId: string, label: string, call: () => Promise<T>): Promise<T | null> => {
        pendingWrites.current[agentId] = (pendingWrites.current[agentId] ?? 0) + 1;
        return enqueue(agentId, async () => {
          try {
            return await call();
          } catch (err) {
            console.warn(`[session-folders] ${label} failed`, err);
            refetchWanted.current.add(agentId);
            return null;
          } finally {
            pendingWrites.current[agentId] -= 1;
            if (pendingWrites.current[agentId] === 0 && refetchWanted.current.delete(agentId)) {
              void fetchAgent(agentId);
            }
          }
        });
      },
      [enqueue, fetchAgent],
    );

    const createFolder = useCallback(
      (agentId: string, name: string) =>
        write(agentId, 'create folder', async () => {
          const { folder } = await api.createSessionFolder(agentId, name);
          update(agentId, (l) => ({ ...l, folders: [...l.folders, folder] }));
          return folder;
        }),
      [api, update, write],
    );

    const renameFolder = useCallback(
      async (agentId: string, folderId: string, name: string) => {
        update(agentId, (l) => ({
          ...l,
          folders: l.folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
        }));
        await write(agentId, 'rename folder', () => api.renameSessionFolder(folderId, name));
      },
      [api, update, write],
    );

    const deleteFolder = useCallback(
      async (agentId: string, folderId: string) => {
        update(agentId, (l) => withoutSessionFolder(l, folderId));
        await write(agentId, 'delete folder', () => api.deleteSessionFolder(folderId));
      },
      [api, update, write],
    );

    const moveSession = useCallback(
      async (agentId: string, sessionId: string, folderId: string | null) => {
        update(agentId, (l) => withSessionFolder(l, sessionId, folderId));
        await write(agentId, 'move session to folder', () =>
          api.setSessionFolder(sessionId, folderId),
        );
      },
      [api, update, write],
    );

    return { foldersByAgentId, loadFolders, createFolder, renameFolder, deleteFolder, moveSession };
  };
}
