import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProactivePrefsQueue, type ProactivePrefsPatch } from '@shared/utils/proactivePrefsQueue';
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import {
  PROACTIVE_AREAS,
  PROACTIVE_AREA_LABELS,
  PROACTIVE_INTERVAL_HOURS,
  PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT,
  type ServerAgentProactivePrefs,
} from '@shared/utils/serverAgentProactive';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

interface Suppression {
  id: string;
  kind: string;
  label: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Proactive mode settings. Peer of the web `ServerAgentProactiveSection`. */
export function ServerAgentProactiveSection({
  enabled: formEnabled = true,
}: {
  enabled?: boolean;
}) {
  const [prefs, setPrefs] = useState<ServerAgentProactivePrefs | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [quietDraft, setQuietDraft] = useState({ start: '', end: '' });
  // Time fields the user is typing in. Saved state (including responses to
  // unrelated saves) only syncs into fields that are not being edited.
  const editingRef = useRef({ start: false, end: false });
  const syncQuietDraft = useCallback((quiet: { start: string; end: string }) => {
    setQuietDraft((d) => ({
      start: editingRef.current.start ? d.start : quiet.start,
      end: editingRef.current.end ? d.end : quiet.end,
    }));
  }, []);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // One serialized queue: each change sends only its own field, and the form
  // shows confirmed state plus pending changes. Peer of the web section.
  const queueRef = useRef<ProactivePrefsQueue | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = (await Promise.all([
        api.getServerAgentProactive(),
        api.listServerAgentSuppressions(),
      ])) as [{ prefs: ServerAgentProactivePrefs }, { suppressions: Suppression[] }];
      if (!queueRef.current) {
        queueRef.current = new ProactivePrefsQueue(
          p.prefs,
          async (patch) =>
            ((await api.putServerAgentProactive(patch)) as { prefs: ServerAgentProactivePrefs })
              .prefs,
          (q) => {
            setPrefs(q.prefs);
            syncQuietDraft(q.prefs.quietHours);
            if (q.error) setStatus({ ok: false, text: q.error });
            else if (q.saved && !q.saving) setStatus({ ok: true, text: 'Saved' });
          },
        );
      }
      setPrefs(p.prefs);
      syncQuietDraft(p.prefs.quietHours);
      setSuppressions(s.suppressions ?? []);
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Could not load.' });
    }
  }, [syncQuietDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (patch: ProactivePrefsPatch) => {
    queueRef.current?.enqueue(patch);
  };

  const editQuiet = (field: 'start' | 'end', text: string) => {
    editingRef.current[field] = true;
    setQuietDraft((d) => ({ ...d, [field]: text }));
  };

  const commitQuiet = (field: 'start' | 'end') => {
    editingRef.current[field] = false;
    if (!prefs) return;
    const value = quietDraft[field].trim();
    if (!HHMM_RE.test(value)) {
      setQuietDraft((d) => ({ ...d, [field]: prefs.quietHours[field] }));
      return;
    }
    if (value !== prefs.quietHours[field]) {
      save({ quietHours: { [field]: value } });
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = (await api.runServerAgentProactiveCheck()) as {
        status: string;
        offers: unknown[];
        error?: string;
      };
      setStatus({
        ok: res.status !== 'error',
        text: res.status === 'ok' ? `${res.offers.length} new offers` : res.error || res.status,
      });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Check failed.' });
    } finally {
      setChecking(false);
    }
  };

  if (!prefs) return null;
  const off = !formEnabled || !prefs.enabled;

  return (
    <View style={styles.section} testID="server-agent-proactive">
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.heading}>Proactive mode</Text>
          <Text style={styles.help}>
            The agent checks in on its own and offers to help. You choose Do it, Not now, or Never
            for that kind. Sending, deleting and merging still ask first.
          </Text>
        </View>
        <Switch
          testID="server-agent-proactive-enabled"
          value={prefs.enabled}
          disabled={!formEnabled}
          onValueChange={(on) => {
            const patch: ProactivePrefsPatch = { enabled: on };
            if (on && prefs.timeZone === 'UTC' && deviceTimeZone() !== 'UTC') {
              patch.timeZone = deviceTimeZone();
            }
            save(patch);
          }}
        />
      </View>

      <Text style={styles.label}>Check in every</Text>
      <View style={styles.chips}>
        {PROACTIVE_INTERVAL_HOURS.map((h) => (
          <TouchableOpacity
            key={h}
            disabled={off}
            onPress={() => save({ intervalHours: h })}
            style={[
              styles.chip,
              prefs.intervalHours === h && styles.chipOn,
              off && styles.disabled,
            ]}
          >
            <Text style={styles.chipText}>{h}h</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, styles.flex]}>Max offers per day: {prefs.maxOffersPerDay}</Text>
        <TouchableOpacity
          disabled={off || prefs.maxOffersPerDay <= 1}
          onPress={() => save({ maxOffersPerDay: prefs.maxOffersPerDay - 1 })}
          style={styles.stepper}
        >
          <Text style={styles.chipText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={off || prefs.maxOffersPerDay >= PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT}
          onPress={() => save({ maxOffersPerDay: prefs.maxOffersPerDay + 1 })}
          style={styles.stepper}
        >
          <Text style={styles.chipText}>+</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, styles.flex]}>Quiet hours ({prefs.timeZone})</Text>
        <Switch
          value={prefs.quietHours.enabled}
          disabled={off}
          onValueChange={(on) => save({ quietHours: { enabled: on } })}
        />
      </View>
      <View style={styles.row}>
        <TextInput
          value={quietDraft.start}
          editable={!off && prefs.quietHours.enabled}
          testID="server-agent-proactive-quiet-start"
          onFocus={() => (editingRef.current.start = true)}
          onChangeText={(t) => editQuiet('start', t)}
          onEndEditing={() => commitQuiet('start')}
          placeholder="22:00"
          placeholderTextColor={colors.gray500}
          style={styles.time}
        />
        <Text style={styles.help}>to</Text>
        <TextInput
          value={quietDraft.end}
          editable={!off && prefs.quietHours.enabled}
          testID="server-agent-proactive-quiet-end"
          onFocus={() => (editingRef.current.end = true)}
          onChangeText={(t) => editQuiet('end', t)}
          onEndEditing={() => commitQuiet('end')}
          placeholder="08:00"
          placeholderTextColor={colors.gray500}
          style={styles.time}
        />
      </View>

      {PROACTIVE_AREAS.map((area) => (
        <View key={area} style={styles.row}>
          <Text style={[styles.body, styles.flex]}>{PROACTIVE_AREA_LABELS[area]}</Text>
          <Switch
            testID={`server-agent-proactive-area-${area}`}
            value={prefs.areas[area]}
            disabled={off}
            onValueChange={(on) => save({ areas: { [area]: on } })}
          />
        </View>
      ))}
      <View style={styles.row}>
        <Text style={[styles.body, styles.flex]}>Push new offers to my devices</Text>
        <Switch
          testID="server-agent-proactive-push"
          value={prefs.push}
          disabled={off}
          onValueChange={(on) => save({ push: on })}
        />
      </View>

      {suppressions.length > 0 ? (
        <View>
          <Text style={styles.label}>Never offer</Text>
          {suppressions.map((s) => (
            <View key={s.id} style={styles.row}>
              <Text style={[styles.body, styles.flex]}>{s.label}</Text>
              <TouchableOpacity
                onPress={async () => {
                  try {
                    await api.deleteServerAgentSuppression(s.id);
                    setSuppressions((list) => list.filter((x) => x.id !== s.id));
                  } catch (err) {
                    setStatus({ ok: false, text: err instanceof Error ? err.message : 'Failed.' });
                  }
                }}
              >
                <Text style={styles.link}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        <TouchableOpacity
          disabled={!formEnabled || checking}
          onPress={() => void checkNow()}
          style={[styles.chip, (!formEnabled || checking) && styles.disabled]}
        >
          <Text style={styles.chipText}>{checking ? 'Checking…' : 'Check now'}</Text>
        </TouchableOpacity>
        {status ? (
          <Text style={[styles.help, { color: status.ok ? colors.emerald400 : colors.red400 }]}>
            {status.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, borderTopWidth: 1, borderTopColor: colors.gray800, paddingTop: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  heading: { color: colors.gray200, fontSize: 14, fontWeight: '600' },
  help: { color: colors.gray500, fontSize: 12 },
  label: { color: colors.gray400, fontSize: 12 },
  body: { color: colors.gray300, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipOn: { borderColor: colors.blue400, backgroundColor: colors.gray800 },
  chipText: { color: colors.gray200, fontSize: 12 },
  stepper: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    width: 32,
    alignItems: 'center',
    paddingVertical: 4,
  },
  time: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    color: colors.white,
    paddingHorizontal: 8,
    paddingVertical: 4,
    width: 70,
  },
  link: { color: colors.blue400, fontSize: 12 },
  disabled: { opacity: 0.5 },
});
