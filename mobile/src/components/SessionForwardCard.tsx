import {
  forwardCardMode,
  orchestrateLaunchMode,
  startedForwardMode,
} from '@shared/utils/orchestrateForwardMode';
import { sessionForwardDispatchKey } from '@shared/utils/sessionForwardDispatchKey';
import React, {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SESSION_FORWARD_MODE_OPTIONS,
  parseSessionForwardMode,
  sessionForwardModeLabel,
  sessionForwardModesFor,
  sessionForwardStorageKey,
  type ExtractedForward,
  type SessionForwardMode,
} from '@shared/utils/extractForwardBlocks';
import { colors } from '../theme/colors';
import { createSessionForwardStore } from '@shared/utils/sessionForwardStore';
import {
  DISMISSED_FORWARD_VALUE,
  createSessionForwardDock,
  dockedForwardsFor,
  parseSavedForwardState,
} from '@shared/utils/sessionForwardDock';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';
import { getServerBaseUrl } from '../utils/config';
import { isWorkflowProject } from '../utils/project-mode';
import { eventsToBlocks } from '../utils/sessionTailBlocks';
import { messageMayHoldForward } from '@shared/utils/userInputRequest';
import {
  cancelOrchestrateAutoStart,
  markOrchestrateAutoStartFired,
  orchestrateAutoStartDeadline,
  orchestrateAutoStartRemaining,
  releaseOrchestrateAutoStart,
  useOrchestrateAutoStartCancelled,
  useOrchestrateLaunchSettings,
  useOrchestrateSessionActive,
} from '../context/orchestrateLaunchSettings';

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

async function readSavedState(key: string | null): Promise<'dismissed' | 'forwarded' | null> {
  if (!key) return null;
  try {
    return parseSavedForwardState(await AsyncStorage.getItem(key));
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
  return `${getServerBaseUrl() ?? ''}|${getAuthRecord()?.user?.id ?? ''}`;
}

async function readForwardRecord(key: string | null): Promise<ForwardRecord | null> {
  if (!key) return null;
  try {
    const raw = await AsyncStorage.getItem(key);
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

/**
 * Same confirm card as the web client. The dropdown is the four ship levels;
 * Session forward is what actually starts the session.
 */
export default function SessionForwardCard({
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
  const launch = useOrchestrateLaunchSettings(sessionId);
  // Auto start belongs to Orchestrate: once the chat leaves that mode, the
  // rail holding the switch is gone and cards go back to a manual press.
  const orchestrating = useOrchestrateSessionActive(sessionId);
  // The Orchestrate chat's Default build for this card; a workflow target
  // resolves it to consult.
  const autoStartMode = orchestrateLaunchMode(allowedModes, launch.mode);
  const mode = forwardCardMode({
    allowed: allowedModes,
    chosen: chosen?.key === identity ? chosen.mode : null,
    suggested: forward.mode,
    orchestrating,
    railMode: launch.mode,
  });
  const setMode = (next: SessionForwardMode) => setChosen({ key: identity, mode: next });
  const [menuOpen, setMenuOpen] = useState(false);
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
  const autoCancelled = useOrchestrateAutoStartCancelled(identity);
  const autoStartOn =
    Boolean(sessionId) &&
    orchestrating &&
    launch.autoStart &&
    !dismissed &&
    !autoCancelled &&
    allowedModes.includes(autoStartMode);
  const [remaining, setRemaining] = useState<number | null>(null);
  const toAgent = (agents || []).find(
    (agent: any) => agent?.id === (record?.agentId || forward.agentId),
  );
  const toName = toAgent?.name || record?.agentId || forward.agentId;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([readForwardRecord(storageKey), readSavedState(storageKey)]).then(
      ([saved, state]) => {
        if (!cancelled)
          setLoaded({ key: identity, record: saved, dismissed: state === 'dismissed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [identity, storageKey]);

  const start = async (modeOverride?: SessionForwardMode): Promise<boolean> => {
    const key = identity;
    const savedKey = storageKey;
    // The claim is in the module store, so a remounted card sees a dispatch
    // that is still in flight and cannot start a second one.
    if (!hydrated || record || dismissed || !forwardStore.claim(key)) return false;
    const ship = modeOverride ?? mode;
    try {
      // The server starts at most one session per card for this user, so a
      // second tab or device pressing or auto-starting it gets the same one.
      const idempotencyKey = sessionForwardDispatchKey({
        sessionId,
        messageId,
        forwardId: forward.forwardId,
        occurrence,
      });
      const request = {
        prompt: forward.prompt,
        agentId: forward.agentId,
        name: forward.name,
        mode: ship,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const started = sessionId
        ? await api.dispatchSession(forward.projectId, request, { parentSessionId: sessionId })
        : await api.dispatchSession(forward.projectId, request);
      const next: ForwardRecord = {
        sessionId: started.sessionId,
        agentId: started.agentId || forward.agentId,
        name: started.name || forward.name,
        mode: startedForwardMode(started.mode, ship),
      };
      try {
        if (savedKey) await AsyncStorage.setItem(savedKey, JSON.stringify(next));
      } catch {
        /* the card still shows forwarded for this visit */
      }
      forwardStore.succeed(key, next);
      return true;
    } catch (err) {
      forwardStore.fail(key, err instanceof Error ? err.message : 'Could not start the session');
      return false;
    }
  };
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (!autoStartOn || !hydrated || record) {
      if (!launch.autoStart || !orchestrating) releaseOrchestrateAutoStart(identity);
      if (!autoStartOn || record) setRemaining(null);
      return;
    }
    if (pending) return;
    orchestrateAutoStartDeadline(identity);
    const tick = () => {
      const left = orchestrateAutoStartRemaining(identity);
      setRemaining(left);
      if (left <= 0 && markOrchestrateAutoStartFired(identity)) {
        void startRef.current(autoStartMode).then((ok) => {
          if (!ok && forwardStore.get(identity)?.status === 'failed') {
            cancelOrchestrateAutoStart(identity);
          }
        });
      }
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [
    autoStartOn,
    hydrated,
    record,
    pending,
    identity,
    launch.autoStart,
    orchestrating,
    autoStartMode,
  ]);

  const counting = autoStartOn && hydrated && !record && remaining != null;

  const dismiss = () => {
    if (!hydrated || record || pending) return;
    forwardStore.dismiss(identity);
    if (storageKey) {
      AsyncStorage.setItem(storageKey, DISMISSED_FORWARD_VALUE).catch(() => {
        /* the card still closes for this visit */
      });
    }
  };

  return (
    <View style={styles.card} testID="session-forward-card">
      <View style={styles.header}>
        <Text style={styles.kicker}>SESSION FORWARD</Text>
        <Text style={styles.title} numberOfLines={1}>
          {forward.name}
        </Text>
      </View>
      <Text style={styles.section}>What it will do</Text>
      <Text testID="session-forward-summary" style={styles.summary}>
        {forward.summary}
      </Text>
      <Text style={styles.forLine}>For {toName}</Text>
      {dismissed ? (
        <View style={styles.footer}>
          <Text testID="session-forward-dismissed" style={styles.note}>
            Dismissed. Nothing was started.
          </Text>
        </View>
      ) : record ? (
        <View style={styles.footer}>
          <Text style={styles.note}>Forwarded as {sessionForwardModeLabel(record.mode)}.</Text>
          {typeof onOpenSession === 'function' ? (
            <Pressable
              testID="session-forward-open"
              accessibilityRole="button"
              onPress={() => onOpenSession(record.agentId, record.sessionId)}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Open session</Text>
            </Pressable>
          ) : null}
        </View>
      ) : counting ? (
        <View style={styles.footer}>
          <Text testID="session-forward-countdown" style={styles.countdown}>
            {remaining != null && remaining > 0
              ? `Starting in ${remaining}s as ${sessionForwardModeLabel(autoStartMode)}`
              : 'Starting…'}
          </Text>
          <View style={styles.countdownActions}>
            <Pressable
              testID="session-forward-start-now"
              accessibilityRole="button"
              accessibilityLabel="Start"
              disabled={pending}
              onPress={() => {
                if (!markOrchestrateAutoStartFired(identity)) return;
                setRemaining(0);
                void start(autoStartMode).then((ok) => {
                  if (!ok && forwardStore.get(identity)?.status === 'failed') {
                    cancelOrchestrateAutoStart(identity);
                  }
                });
              }}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Start</Text>
            </Pressable>
            <Pressable
              testID="session-forward-cancel-auto"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => {
                cancelOrchestrateAutoStart(identity);
                setRemaining(null);
              }}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.footer}>
          <Text style={styles.section}>Automation</Text>
          <Pressable
            testID="session-forward-mode"
            accessibilityRole="button"
            accessibilityLabel="Automation"
            onPress={() => setMenuOpen((open) => !open)}
            style={styles.select}
          >
            <Text style={styles.selectText}>{selected?.label}</Text>
          </Pressable>
          {menuOpen
            ? modeOptions.map((option) => (
                <Pressable
                  key={option.value}
                  testID={`session-forward-mode-${option.value}`}
                  accessibilityRole="button"
                  onPress={() => {
                    setMode(option.value);
                    setMenuOpen(false);
                  }}
                  style={styles.option}
                >
                  <Text style={styles.optionText}>{option.label}</Text>
                  <Text style={styles.optionHint}>{option.description}</Text>
                </Pressable>
              ))
            : null}
          {!menuOpen ? <Text style={styles.note}>{selected?.description}</Text> : null}
          <Pressable
            testID="session-forward"
            accessibilityRole="button"
            accessibilityLabel="Session forward"
            disabled={pending || !hydrated}
            onPress={() => void start()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{pending ? 'Starting…' : 'Session forward'}</Text>
          </Pressable>
          <Pressable
            testID="session-forward-dismiss"
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            disabled={pending || !hydrated}
            onPress={dismiss}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Dismiss</Text>
          </Pressable>
          {error ? (
            <Text testID="session-forward-error" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { paddingHorizontal: 12 },
  card: {
    marginVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 83, 9, 0.4)',
    borderRadius: 12,
    backgroundColor: colors.amber900_40,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(180, 83, 9, 0.35)',
    gap: 2,
  },
  kicker: { color: colors.amber400, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { color: colors.white, fontSize: 14, fontWeight: '600' },
  section: {
    marginTop: 8,
    marginHorizontal: 12,
    color: colors.amber400,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  summary: { marginHorizontal: 12, marginTop: 4, color: colors.gray200, fontSize: 14 },
  forLine: { marginHorizontal: 12, marginTop: 6, color: colors.gray400, fontSize: 12 },
  footer: { paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  select: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectText: { color: colors.gray100, fontSize: 14 },
  option: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  optionText: { color: colors.gray100, fontSize: 14 },
  optionHint: { color: colors.gray400, fontSize: 11, marginTop: 2 },
  note: { color: colors.gray400, fontSize: 11 },
  button: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(180, 83, 9, 0.5)',
    borderRadius: 8,
    backgroundColor: 'rgba(120, 53, 15, 0.45)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  buttonText: { color: colors.amber400, fontSize: 13, fontWeight: '600' },
  secondaryButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryButtonText: { color: colors.gray400, fontSize: 13, fontWeight: '600' },
  error: { color: colors.red400, fontSize: 12 },
  countdown: { color: colors.amber400, fontSize: 13 },
  countdownActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cancel: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  cancelText: { color: colors.gray300, fontSize: 13 },
});

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
  const [saved, setSaved] = useState<{
    key: string;
    state: 'dismissed' | 'forwarded' | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readSavedState(storageKey).then((state) => {
      if (!cancelled) setSaved({ key: identity, state });
    });
    return () => {
      cancelled = true;
    };
  }, [identity, storageKey]);
  const hydrated = saved?.key === identity;
  const resolved =
    entry?.status === 'done' ||
    entry?.status === 'dismissed' ||
    (entry?.status !== 'pending' && hydrated && saved?.state != null);
  const dockable = docked && !streaming && !!sessionId && messageId != null;
  const pin = dockable && hydrated && !resolved;

  useEffect(() => {
    if (pin && sessionId && messageId != null) {
      forwardDock.pin({ identity, chatSessionId: sessionId, messageId, forward, occurrence });
    } else if (resolved) {
      forwardDock.unpin(identity);
    }
  }, [pin, resolved, identity, sessionId, messageId, forward, occurrence]);

  // Until the saved state is read, a dockable card could be either; show nothing.
  if (dockable && !resolved && !hydrated) return null;
  return pin ? null : <SessionForwardCard {...cardProps} />;
});

/** Leaves the dock on its own once resolved, even if its row is virtualized away. */
function DockedCard({ identity, ...props }: CardProps & { identity: string }) {
  const entry = useForwardEntry(identity);
  const resolved = entry?.status === 'done' || entry?.status === 'dismissed';
  useEffect(() => {
    if (resolved) forwardDock.unpin(identity);
  }, [resolved, identity]);
  return <SessionForwardCard {...props} />;
}

/** Pinned cards for one chat; the chat adds a list row only when there are some. */
export function useDockedForwards(chatSessionId: string | null | undefined) {
  const snapshot = useSyncExternalStore(forwardDock.subscribe, forwardDock.snapshot);
  return useMemo(() => dockedForwardsFor(snapshot, chatSessionId), [snapshot, chatSessionId]);
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
  const pinned = useDockedForwards(chatSessionId);
  if (pinned.length === 0) return null;
  return (
    <View testID="session-forward-dock" style={styles.dock}>
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
    </View>
  );
}

/**
 * Pin one message's open cards. False when its events could not be loaded,
 * so the caller knows the message still needs a check.
 */
async function pinOpenForwardsOf(
  message: any,
  eventsByMessage: Record<string, unknown>,
  loadEvents: (messageId: string) => Promise<unknown[] | null>,
): Promise<boolean> {
  const known = eventsByMessage[message.id];
  const events = Array.isArray(known) ? known : await loadEvents(String(message.id));
  if (!Array.isArray(events)) return false;
  const blocks = eventsToBlocks(events).filter((block: any) => block.kind === 'session_forward');
  for (const block of blocks) {
    const { type: _type, ...forward } = block.event as ExtractedForward & { type?: string };
    const occurrence = block.occurrence ?? 0;
    const { storageKey, identity } = cardKeys(
      message.session_id,
      message.id,
      forward.forwardId,
      occurrence,
    );
    const status = forwardStore.get(identity)?.status;
    if (status === 'done' || status === 'dismissed') continue;
    if (status !== 'pending' && (await readSavedState(storageKey)) !== null) continue;
    forwardDock.pin({
      identity,
      chatSessionId: message.session_id,
      messageId: message.id,
      forward,
      occurrence,
    });
  }
  return true;
}

export interface OpenForwardScanner {
  /**
   * Check every message not yet checked. Resolves to the ids whose events
   * could not be loaded; those stay unchecked and are tried on the next scan.
   */
  scan(messages: ReadonlyArray<any>, eventsByMessage: Record<string, unknown>): Promise<string[]>;
}

/**
 * Pins a chat's open cards from its loaded messages, without waiting for
 * their rows to mount. A long chat opens scrolled to the end, so the FlatList
 * may never render the row that proposed a card. Only rows stamped as holding
 * a forward have their events loaded. A message counts as checked only after
 * its check succeeds; one in flight is skipped, a failed one is retried.
 */
export function createOpenForwardScanner(
  loadEvents: (messageId: string) => Promise<unknown[] | null>,
): OpenForwardScanner {
  const checked = new Set<string>();
  // A scan that finds a message already in flight waits for that check, so
  // its failure is reported by whichever scan is still listening.
  const inFlight = new Map<string, Promise<boolean>>();
  return {
    async scan(messages, eventsByMessage) {
      const work: Array<Promise<string | null>> = [];
      for (const message of messages) {
        const id = message?.id == null ? '' : String(message.id);
        if (!id || checked.has(id)) continue;
        let check = inFlight.get(id);
        if (!check) {
          if (!message.session_id || !messageMayHoldForward(message)) {
            checked.add(id);
            continue;
          }
          check = pinOpenForwardsOf(message, eventsByMessage, loadEvents)
            .catch(() => false)
            .then((ok) => {
              inFlight.delete(id);
              if (ok) checked.add(id);
              return ok;
            });
          inFlight.set(id, check);
        }
        work.push(check.then((ok) => (ok ? null : id)));
      }
      const results = await Promise.all(work);
      return results.filter((id): id is string => id !== null);
    },
  };
}
