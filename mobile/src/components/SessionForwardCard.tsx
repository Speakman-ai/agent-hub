import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { colors } from '../theme/colors';
import { createSessionForwardStore } from '@shared/utils/sessionForwardStore';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';
import { getServerBaseUrl } from '../utils/config';
import { isWorkflowProject } from '../utils/project-mode';

interface ForwardRecord {
  sessionId: string;
  agentId: string;
  name: string;
  mode: SessionForwardMode;
}

/** Dispatch state per card identity for this client; outlives card mounts. */
export const forwardStore = createSessionForwardStore<ForwardRecord>();

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
  const storageKey = useMemo(
    () =>
      sessionForwardStorageKey({
        owner: storageOwner(),
        sessionId,
        messageId,
        forwardId: forward.forwardId,
        occurrence,
      }),
    [sessionId, messageId, forward.forwardId, occurrence],
  );
  // Which card this is. The component can be reused for another card (the
  // web tail keys blocks by position) or unmount mid-dispatch, so dispatch
  // state lives in `forwardStore` under this identity and the rest of the
  // local state below is tagged with it.
  const identity =
    storageKey ??
    ['local', sessionId ?? '', String(messageId ?? ''), forward.forwardId, occurrence].join(':');
  const [chosen, setChosen] = useState<{ key: string; mode: SessionForwardMode } | null>(null);
  const mode = initialSessionForwardMode(
    allowedModes,
    chosen?.key === identity ? chosen.mode : forward.mode,
  );
  const setMode = (next: SessionForwardMode) => setChosen({ key: identity, mode: next });
  const [menuOpen, setMenuOpen] = useState(false);
  // `loaded` is the saved record for one identity. Until it matches the
  // current card, that card may already be forwarded, so Session forward
  // stays disabled.
  const [loaded, setLoaded] = useState<{ key: string; record: ForwardRecord | null } | null>(null);
  const hydrated = loaded?.key === identity;
  const savedRecord = hydrated ? (loaded?.record ?? null) : null;
  const entry = useSyncExternalStore(
    (onChange) => forwardStore.subscribe(identity, onChange),
    () => forwardStore.get(identity),
  );
  const pending = entry?.status === 'pending';
  const error = entry?.status === 'failed' ? entry.message : null;
  const record = entry?.status === 'done' ? entry.record : savedRecord;
  const selected = modeOptions.find((option) => option.value === mode) ?? modeOptions[0];
  const toAgent = (agents || []).find(
    (agent: any) => agent?.id === (record?.agentId || forward.agentId),
  );
  const toName = toAgent?.name || record?.agentId || forward.agentId;

  useEffect(() => {
    let cancelled = false;
    void readForwardRecord(storageKey).then((saved) => {
      if (!cancelled) setLoaded({ key: identity, record: saved });
    });
    return () => {
      cancelled = true;
    };
  }, [identity, storageKey]);

  const start = async () => {
    const key = identity;
    const savedKey = storageKey;
    // The claim is in the module store, so a remounted card sees a dispatch
    // that is still in flight and cannot start a second one.
    if (!hydrated || record || !forwardStore.claim(key)) return;
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
      try {
        if (savedKey) await AsyncStorage.setItem(savedKey, JSON.stringify(next));
      } catch {
        /* the card still shows forwarded for this visit */
      }
      forwardStore.succeed(key, next);
    } catch (err) {
      forwardStore.fail(key, err instanceof Error ? err.message : 'Could not start the session');
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
      {record ? (
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
  error: { color: colors.red400, fontSize: 12 },
});
