import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, ExternalLink, X } from 'lucide-react';
import {
  SESSION_FORWARD_MODE_OPTIONS,
  initialSessionForwardMode,
  parseSessionForwardMode,
  sessionForwardModeLabel,
  sessionForwardModesFor,
  sessionForwardStorageKey,
  type ExtractedForward,
  type SessionForwardMode,
} from '@shared/utils/extractForwardBlocks';
import { createSessionForwardStore } from '@shared/utils/sessionForwardStore';
import {
  DISMISSED_FORWARD_VALUE,
  createSessionForwardDock,
  dockedForwardsFor,
  parseSavedForwardState,
} from '@shared/utils/sessionForwardDock';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';
import { getServerBase } from '../utils/connection';
import { isWorkflowProject } from '../utils/projectMode';

interface ForwardRecord {
  sessionId: string;
  agentId: string;
  name: string;
  mode: SessionForwardMode;
}

/** Dispatch state per card identity for this client; outlives card mounts. */
export const forwardStore = createSessionForwardStore<ForwardRecord>();

/** Open cards pinned to the end of their chat; see `sessionForwardDock`. */
export const forwardDock = createSessionForwardDock();

/**
 * True inside a chat that renders `SessionForwardDock`. Without it a card
 * stays in its message, so a surface with no dock never loses one.
 */
export const SessionForwardDockContext = createContext(false);

function cardKeys(
  sessionId: string | null | undefined,
  messageId: string | number | null | undefined,
  forwardId: string,
  occurrence: number,
): { storageKey: string | null; identity: string } {
  const storageKey = sessionForwardStorageKey({
    owner: storageOwner(),
    sessionId,
    messageId,
    forwardId,
    occurrence,
  });
  return {
    storageKey,
    identity:
      storageKey ??
      ['local', sessionId ?? '', String(messageId ?? ''), forwardId, occurrence].join(':'),
  };
}

function readSavedState(key: string | null): 'dismissed' | 'forwarded' | null {
  if (!key) return null;
  try {
    return parseSavedForwardState(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function useForwardEntry(identity: string) {
  return useSyncExternalStore(
    (onChange) => forwardStore.subscribe(identity, onChange),
    () => forwardStore.get(identity),
  );
}

function storageOwner(): string {
  const server = getServerBase() || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${server}|${getAuthRecord()?.user?.id ?? ''}`;
}

function readForwardRecord(key: string | null): ForwardRecord | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ForwardRecord>;
    if (!parsed.sessionId || !parsed.agentId) return null;
    return {
      sessionId: parsed.sessionId,
      agentId: parsed.agentId,
      name: parsed.name || 'New session',
      mode: parseSessionForwardMode(parsed.mode),
    };
  } catch {
    return null;
  }
}

function writeForwardRecord(key: string | null, record: ForwardRecord): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    /* a private window can refuse storage; the card still shows this turn */
  }
}

function agentName(agents: any[] | undefined, agentId: string): string {
  const match = (agents || []).find((agent: any) => agent?.id === agentId);
  return match?.name || agentId;
}

/**
 * Confirm-then-start card. The session does not exist until Session forward
 * is pressed, and the dropdown is the ship level that press will use.
 */
function SessionForwardCard({
  forward,
  occurrence = 0,
  sessionId,
  messageId,
  agents,
  projects,
  onOpenSession,
}: {
  forward: ExtractedForward;
  /** Position among cards with this id in the same message. */
  occurrence?: number;
  /** Chat session and message the card was posted in. */
  sessionId?: string | null;
  messageId?: string | number | null;
  agents?: any[];
  projects?: any[];
  onOpenSession?: (agentId: string, sessionId: string) => void;
}) {
  const targetProject = (projects || []).find((project: any) => project?.id === forward.projectId);
  const allowedModes = sessionForwardModesFor(
    targetProject ? isWorkflowProject(targetProject) : null,
    forward.mode,
  );
  const modeOptions = SESSION_FORWARD_MODE_OPTIONS.filter((option) =>
    allowedModes.includes(option.value),
  );
  const { storageKey, identity } = useMemo(
    () => cardKeys(sessionId, messageId, forward.forwardId, occurrence),
    [sessionId, messageId, forward.forwardId, occurrence],
  );
  const [chosen, setChosen] = useState<{ key: string; mode: SessionForwardMode } | null>(null);
  const mode = initialSessionForwardMode(
    allowedModes,
    chosen?.key === identity ? chosen.mode : forward.mode,
  );
  const setMode = (next: SessionForwardMode) => setChosen({ key: identity, mode: next });
  // `loaded` is the saved record for one identity. Until it matches the
  // current card, that card may already be forwarded, so Session forward
  // stays disabled.
  const [loaded, setLoaded] = useState<{
    key: string;
    record: ForwardRecord | null;
    dismissed: boolean;
  } | null>(null);
  const hydrated = loaded?.key === identity;
  const savedRecord = hydrated ? (loaded?.record ?? null) : null;
  const entry = useForwardEntry(identity);
  const pending = entry?.status === 'pending';
  const error = entry?.status === 'failed' ? entry.message : null;
  const record = entry?.status === 'done' ? entry.record : savedRecord;
  const dismissed = !record && (entry?.status === 'dismissed' || (hydrated && !!loaded?.dismissed));
  const selected = modeOptions.find((option) => option.value === mode) ?? modeOptions[0];

  useEffect(() => {
    setLoaded({
      key: identity,
      record: readForwardRecord(storageKey),
      dismissed: readSavedState(storageKey) === 'dismissed',
    });
  }, [identity, storageKey]);

  const start = async () => {
    const key = identity;
    const savedKey = storageKey;
    // The claim is in the module store, so a remounted card sees a dispatch
    // that is still in flight and cannot start a second one.
    if (!hydrated || record || dismissed || !forwardStore.claim(key)) return;
    try {
      const started = await api.dispatchSession(forward.projectId, {
        prompt: forward.prompt,
        agentId: forward.agentId,
        name: forward.name,
        mode,
      });
      const next: ForwardRecord = {
        sessionId: started.sessionId,
        agentId: started.agentId || forward.agentId,
        name: started.name || forward.name,
        mode,
      };
      writeForwardRecord(savedKey, next);
      forwardStore.succeed(key, next);
    } catch (err) {
      forwardStore.fail(key, err instanceof Error ? err.message : 'Could not start the session');
    }
  };

  const dismiss = () => {
    if (!hydrated || record || pending) return;
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, DISMISSED_FORWARD_VALUE);
      } catch {
        /* the card still closes for this visit */
      }
    }
    forwardStore.dismiss(identity);
  };

  const toName = agentName(agents, record?.agentId || forward.agentId);

  return (
    <div
      data-testid="session-forward-card"
      className="my-2 overflow-hidden rounded-xl border border-amber-700/40 bg-gradient-to-br from-amber-950/30 to-gray-900/40"
    >
      <div className="flex items-center gap-2 border-b border-amber-800/30 bg-amber-950/30 px-4 py-2.5">
        <ArrowRight size={14} className="flex-shrink-0 text-amber-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
          Session forward
        </span>
        <span className="min-w-0 truncate text-sm text-amber-100">{forward.name}</span>
      </div>
      <div className="px-4 py-3">
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-amber-200/60">
          What it will do
        </div>
        <div
          data-testid="session-forward-summary"
          className="markdown-content text-sm leading-relaxed text-gray-200"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{forward.summary}</ReactMarkdown>
        </div>
        <p className="mt-2 text-xs text-gray-400">For {toName}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3 pt-1">
        {dismissed ? (
          <p
            data-testid="session-forward-dismissed"
            className="min-w-[12rem] flex-1 text-[11px] italic text-gray-500"
          >
            Dismissed. Nothing was started.
          </p>
        ) : record ? (
          <>
            <p className="min-w-[12rem] flex-1 text-[11px] italic text-gray-500">
              Forwarded as {sessionForwardModeLabel(record.mode)}.
            </p>
            {typeof onOpenSession === 'function' && (
              <button
                type="button"
                data-testid="session-forward-open"
                onClick={() => onOpenSession(record.agentId, record.sessionId)}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-900/40 px-2.5 py-1 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-800/60"
              >
                <ExternalLink size={12} />
                Open session
              </button>
            )}
          </>
        ) : (
          <>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-amber-200/60">
                Automation
              </span>
              <select
                data-testid="session-forward-mode"
                value={mode}
                onChange={(event) => setMode(parseSessionForwardMode(event.target.value))}
                className="min-w-0 max-w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100"
              >
                {modeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-gray-500">{selected?.description}</span>
            </label>
            <button
              type="button"
              data-testid="session-forward"
              disabled={pending || !hydrated}
              onClick={() => void start()}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-amber-700/50 bg-amber-900/40 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-800/60 disabled:opacity-60"
            >
              <ArrowRight size={12} />
              {pending ? 'Starting…' : 'Session forward'}
            </button>
            <button
              type="button"
              data-testid="session-forward-dismiss"
              disabled={pending || !hydrated}
              onClick={dismiss}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:opacity-60"
            >
              <X size={12} />
              Dismiss
            </button>
            {error && (
              <p data-testid="session-forward-error" className="w-full text-xs text-red-300">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const Card = memo(SessionForwardCard);
export default Card;

type CardProps = Parameters<typeof SessionForwardCard>[0];

/**
 * The card's place in its message. While the card is open and the chat has a
 * dock, it is pinned to the end of the chat and this renders nothing; once it
 * is launched or dismissed it renders here, in the message that proposed it.
 * A streaming message keeps its card inline: it is already at the bottom.
 */
export const SessionForwardSlot = memo(function SessionForwardSlot(
  props: CardProps & { streaming?: boolean },
) {
  const { streaming, ...cardProps } = props;
  const { forward, sessionId, messageId } = cardProps;
  const occurrence = cardProps.occurrence ?? 0;
  const docked = useContext(SessionForwardDockContext);
  const { storageKey, identity } = useMemo(
    () => cardKeys(sessionId, messageId, forward.forwardId, occurrence),
    [sessionId, messageId, forward.forwardId, occurrence],
  );
  const entry = useForwardEntry(identity);
  const resolved =
    entry?.status === 'done' ||
    entry?.status === 'dismissed' ||
    (entry?.status !== 'pending' && readSavedState(storageKey) !== null);
  const pin = docked && !streaming && !resolved && !!sessionId && messageId != null;

  useEffect(() => {
    if (pin && sessionId && messageId != null) {
      forwardDock.pin({ identity, chatSessionId: sessionId, messageId, forward, occurrence });
    } else if (resolved) {
      forwardDock.unpin(identity);
    }
  }, [pin, resolved, identity, sessionId, messageId, forward, occurrence]);

  return pin ? null : <Card {...cardProps} />;
});

/** Leaves the dock on its own once resolved, even if its message is not mounted. */
function DockedCard({ identity, ...props }: CardProps & { identity: string }) {
  const entry = useForwardEntry(identity);
  const resolved = entry?.status === 'done' || entry?.status === 'dismissed';
  useEffect(() => {
    if (resolved) forwardDock.unpin(identity);
  }, [resolved, identity]);
  return <Card {...props} />;
}

/** Open cards for one chat, rendered after its last message. */
export function SessionForwardDock({
  chatSessionId,
  agents,
  projects,
  onOpenSession,
}: {
  chatSessionId: string | null | undefined;
  agents?: any[];
  projects?: any[];
  onOpenSession?: (agentId: string, sessionId: string) => void;
}) {
  const snapshot = useSyncExternalStore(forwardDock.subscribe, forwardDock.snapshot);
  const pinned = useMemo(
    () => dockedForwardsFor(snapshot, chatSessionId),
    [snapshot, chatSessionId],
  );
  if (pinned.length === 0) return null;
  return (
    <div data-testid="session-forward-dock">
      {pinned.map((entry) => (
        <DockedCard
          key={entry.identity}
          identity={entry.identity}
          forward={entry.forward}
          occurrence={entry.occurrence}
          sessionId={entry.chatSessionId}
          messageId={entry.messageId}
          agents={agents}
          projects={projects}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}
